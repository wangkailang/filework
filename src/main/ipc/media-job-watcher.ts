/**
 * 媒体任务 Watcher(Phase 3)。
 *
 * MiniMax 视频生成需异步运行 1–5 分钟。在
 * `media:create-video-job` IPC 提交任务并向 `media_jobs`
 * 写入一行后,该 watcher 每隔 TICK_MS 轮询
 * `/v1/query/video_generation`,更新 DB 行,并发出 `ai:media-job-update` IPC 事件,
 * 使渲染进程的 `VideoJobPart` 卡片能展示进度 / 最终视频。
 *
 * 仿照 `ci-watcher.ts` —— 采用相同的单例 + AbortSignal 模式。
 * 区别在于:我们将状态持久化到 DB,使渲染进程重新加载后可通过
 * `media:subscribe-job` 重新挂接到进行中的任务。
 */

import type { WebContents } from "electron";

import { MinimaxApiError } from "../ai/minimax/types";
import { queryVideo, retrieveFile } from "../ai/minimax/video-client";
import {
  getLlmConfig,
  getMediaJob,
  type MediaJobStatus,
  updateMediaJob,
} from "../db";
import { saveMediaToDisk } from "./media-storage";

// 20 秒间隔 —— MiniMax 视频通常运行 1–5 分钟,因此每个任务约
// 轮询 3-15 次,相比 15 秒间隔的约 4-20 次。在不影响 UX 的前提下
// 省去约四分之一的空闲 "Queueing" 查询(状态翻转仍会在
// 用户重新关注之前及时到达)。
export const TICK_MS = 20_000;
export const TIMEOUT_MS = 10 * 60_000;

interface WatchDeps {
  fetchFn: typeof fetch;
}

/**
 * 在订阅时捕获,使 `tick()` 不必每 20 秒从 DB 重新解析 LLM
 * config 与 media-job 行。watcher 只需要这些标量字段;
 * 若某行在上游被修改(取消等),
 * AbortSignal 监听器会拆除该 watch,而非与 DB
 * 读取产生竞态。
 */
interface WatchEntry {
  jobId: string;
  sessionId: string;
  apiKey: string;
  baseUrl: string | null;
  providerJobId: string;
  startedAt: number;
  intervalId: ReturnType<typeof setInterval>;
  timeoutId: ReturnType<typeof setTimeout>;
  signal: AbortSignal;
  abortListener: () => void;
  /** 可选的调用方回调,在 watch entry 因任何原因退出时触发。 */
  onUnsubscribe?: (jobId: string) => void;
  /** 最近一次发出的状态,用于抑制重复的 "running" 通知。 */
  emittedStatus: MediaJobStatus;
}

export interface SubscribeInput {
  jobId: string;
  sender: WebContents;
  signal: AbortSignal;
  /** 可选的清理回调 —— media-handlers 用它来释放自身的 AbortController。 */
  onUnsubscribe?: (jobId: string) => void;
}

export interface MediaJobUpdateEvent {
  jobId: string;
  status: MediaJobStatus;
  progressPct?: number | null;
  resultPath?: string | null;
  errorMessage?: string | null;
}

class MediaJobWatcher {
  private readonly entries = new Map<string, WatchEntry>();
  private deps: WatchDeps | null = null;

  configure(deps: WatchDeps): void {
    this.deps = deps;
  }

  size(): number {
    return this.entries.size;
  }

  /**
   * 订阅一个已存在的 media_jobs 行。按 `jobId` 去重 ——
   * 渲染进程重新加载后再次订阅不会导致重复轮询。
   * 若任务已处于终止状态或不存在,则返回 `false`。
   */
  subscribe(input: SubscribeInput): boolean {
    if (!this.deps) {
      console.warn("[media-job-watcher] subscribe before configure()");
      return false;
    }
    if (this.entries.has(input.jobId)) return true;

    const job = getMediaJob(input.jobId);
    if (!job) return false;
    if (
      job.status === "succeeded" ||
      job.status === "failed" ||
      job.status === "canceled"
    ) {
      return false;
    }
    const config = getLlmConfig(job.configId);
    if (!config?.apiKey || !job.providerJobId) {
      updateMediaJob(input.jobId, {
        status: "failed",
        errorMessage: "missing config / provider task id",
        completedAt: new Date().toISOString(),
      });
      this.emit(input.sender, {
        jobId: input.jobId,
        status: "failed",
        errorMessage: "missing config / provider task id",
      });
      input.onUnsubscribe?.(input.jobId);
      return false;
    }

    const tick = async () => {
      const entry = this.entries.get(input.jobId);
      if (!entry || input.sender.isDestroyed() || input.signal.aborted) {
        this.unsubscribe(input.jobId);
        return;
      }
      try {
        const result = await queryVideo({
          apiKey: entry.apiKey,
          baseUrl: entry.baseUrl,
          taskId: entry.providerJobId,
          fetchImpl: this.deps?.fetchFn,
          signal: input.signal,
        });

        if (result.status === "Success" && result.fileId) {
          await this.finalize(entry, input.sender, result.fileId);
          return;
        }
        if (result.status === "Fail") {
          updateMediaJob(input.jobId, {
            status: "failed",
            errorMessage: "MiniMax reported task Fail",
            completedAt: new Date().toISOString(),
          });
          this.emit(input.sender, {
            jobId: input.jobId,
            status: "failed",
            errorMessage: "MiniMax reported task Fail",
          });
          this.unsubscribe(input.jobId);
          return;
        }
        // Queueing / Preparing / Processing —— 继续轮询。MiniMax
        // 不提供真实百分比;一旦轮询显示已越过排队阶段,
        // 我们就将持久化状态翻转为 "running",
        // 且仅在该状态实际变化时才发出事件。
        const wantsRunning =
          result.status === "Preparing" || result.status === "Processing";
        const nextStatus: MediaJobStatus = wantsRunning ? "running" : "queued";
        if (entry.emittedStatus !== nextStatus) {
          updateMediaJob(input.jobId, { status: nextStatus });
          this.emit(input.sender, {
            jobId: input.jobId,
            status: nextStatus,
          });
          entry.emittedStatus = nextStatus;
        }
      } catch (err) {
        const msg =
          err instanceof MinimaxApiError
            ? err.message
            : err instanceof Error
              ? err.message
              : String(err);
        console.warn(
          `[media-job-watcher] tick error for ${input.jobId}: ${msg}`,
        );
        // 网络抖动 —— 等待下一次 tick。真正的错误会重复出现。
      }
    };

    const intervalId = setInterval(tick, TICK_MS);
    const timeoutId = setTimeout(() => {
      updateMediaJob(input.jobId, {
        status: "failed",
        errorMessage: `Timed out after ${Math.round(TIMEOUT_MS / 1000)}s`,
        completedAt: new Date().toISOString(),
      });
      if (!input.sender.isDestroyed()) {
        this.emit(input.sender, {
          jobId: input.jobId,
          status: "failed",
          errorMessage: `Timed out after ${Math.round(TIMEOUT_MS / 1000)}s`,
        });
      }
      this.unsubscribe(input.jobId);
    }, TIMEOUT_MS);

    const abortListener = () => {
      // Abort 来自用户点击取消或渲染进程被销毁。
      // media-handlers.ts 中的取消处理器才是负责
      // 向 DB 写入 status=canceled 的一方;此监听器仅拆除
      // 定时器。
      this.unsubscribe(input.jobId);
    };
    input.signal.addEventListener("abort", abortListener, { once: true });

    this.entries.set(input.jobId, {
      jobId: input.jobId,
      sessionId: job.sessionId,
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      providerJobId: job.providerJobId,
      startedAt: Date.now(),
      intervalId,
      timeoutId,
      signal: input.signal,
      abortListener,
      onUnsubscribe: input.onUnsubscribe,
      emittedStatus: job.status,
    });

    // 立即触发首次轮询,避免 UI 在首次状态转换前
    // 卡在 "queued" 长达整整一个 TICK_MS。
    void tick();
    return true;
  }

  unsubscribe(jobId: string): void {
    const entry = this.entries.get(jobId);
    if (!entry) return;
    clearInterval(entry.intervalId);
    clearTimeout(entry.timeoutId);
    entry.signal.removeEventListener("abort", entry.abortListener);
    this.entries.delete(jobId);
    entry.onUnsubscribe?.(jobId);
  }

  private emit(sender: WebContents, event: MediaJobUpdateEvent): void {
    if (sender.isDestroyed()) return;
    sender.send("ai:media-job-update", event);
  }

  private async finalize(
    entry: WatchEntry,
    sender: WebContents,
    fileId: string,
  ): Promise<void> {
    if (!this.deps) return;
    try {
      const file = await retrieveFile({
        apiKey: entry.apiKey,
        baseUrl: entry.baseUrl,
        fileId,
        fetchImpl: this.deps.fetchFn,
        signal: entry.signal,
      });

      const saved = await saveMediaToDisk(
        this.deps.fetchFn,
        file.downloadUrl,
        entry.sessionId,
        "mp4",
      );

      updateMediaJob(entry.jobId, {
        status: "succeeded",
        resultPath: saved.path,
        completedAt: new Date().toISOString(),
      });
      this.emit(sender, {
        jobId: entry.jobId,
        status: "succeeded",
        resultPath: saved.path,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      updateMediaJob(entry.jobId, {
        status: "failed",
        errorMessage: msg,
        completedAt: new Date().toISOString(),
      });
      this.emit(sender, {
        jobId: entry.jobId,
        status: "failed",
        errorMessage: msg,
      });
    } finally {
      this.unsubscribe(entry.jobId);
    }
  }
}

export const mediaJobWatcher = new MediaJobWatcher();
export const __test__ = { MediaJobWatcher };
