/**
 * Media Job Watcher (Phase 3).
 *
 * MiniMax video generation runs 1–5 minutes asynchronously. After the
 * `media:create-video-job` IPC submits a job and writes a row to
 * `media_jobs`, this watcher polls `/v1/query/video_generation` every
 * TICK_MS, updates the DB row, and emits `ai:media-job-update` IPC events
 * so the renderer's `VideoJobPart` card can show progress / final video.
 *
 * Modeled after `ci-watcher.ts` — same singleton + AbortSignal pattern.
 * Difference: we persist to the DB so a renderer reload can re-attach
 * to an in-flight job via `media:subscribe-job`.
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

// 20s cadence — MiniMax video typically runs 1–5 min, so this lands
// ~3-15 polls per job vs ~4-20 at 15s. Saves roughly a quarter of the
// idle "Queueing" queries with no UX impact (status flips still arrive
// well before user attention re-engages).
export const TICK_MS = 20_000;
export const TIMEOUT_MS = 10 * 60_000;

interface WatchDeps {
  fetchFn: typeof fetch;
}

/**
 * Captured at subscribe-time so `tick()` doesn't re-resolve the LLM
 * config + media-job row from the DB every 20s. The watcher only needs
 * these scalar fields; if a row mutates upstream (cancel, etc.) the
 * AbortSignal listener tears the watch down rather than racing with DB
 * reads.
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
  /** Optional caller hook fired when a watch entry exits for any reason. */
  onUnsubscribe?: (jobId: string) => void;
  /** Latest status emitted, so we suppress repeat "running" notifications. */
  emittedStatus: MediaJobStatus;
}

export interface SubscribeInput {
  jobId: string;
  sender: WebContents;
  signal: AbortSignal;
  /** Optional cleanup hook — used by media-handlers to free its AbortController. */
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
   * Subscribe to an existing media_jobs row. Duplicates are deduped on
   * `jobId` — a renderer reload that re-subscribes won't double-poll.
   * Returns `false` if the job is already terminal or not found.
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
        // Queueing / Preparing / Processing — keep polling. MiniMax
        // doesn't expose a real percentage; we flip the persisted
        // status to "running" once polling shows we're past the queue
        // and only emit when that bucket actually changes.
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
        // Network blip — wait for next tick. Real errors will repeat.
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
      // Abort comes from the user clicking Cancel or the renderer being
      // destroyed. The cancel handler in media-handlers.ts is the side
      // that writes status=canceled to the DB; this listener only tears
      // down the timers.
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

    // Kick off the first poll immediately so the UI doesn't sit on
    // "queued" for a full TICK_MS before the first transition.
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
