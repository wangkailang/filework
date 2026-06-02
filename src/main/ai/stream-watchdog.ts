/**
 * 流监视器(Stream Watchdog)—— 针对 AI 流式输出的卡死检测与超时控制。
 *
 * 监控流式活动并:
 * 1. 检测卡死(在可配置的时长内无任何活动)
 * 2. 可在卡死超时时触发 abort
 */

import type { WebContents } from "electron";

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export type WatchdogEventType =
  | "stall-warning"
  | "stall-recovered"
  | "stall-timeout";

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

export interface WatchdogOptions {
  /** 用于事件关联的任务 ID */
  taskId: string;
  /** 接收事件的 Electron WebContents */
  sender: WebContents;
  /** 心跳间隔(毫秒,默认 3000) */
  heartbeatIntervalMs?: number;
  /** 卡死阈值(毫秒)—— 触发警告(默认 30000) */
  stallWarningMs?: number;
  /** 硬超时(毫秒)—— 若设置则触发 abort(默认 300000 = 5 分钟) */
  hardTimeoutMs?: number;
  /** 硬超时时触发的 AbortController */
  abortController?: AbortController;
  /** 计划相关的元数据 */
  planId?: string;
  stepId?: number;
}

// ---------------------------------------------------------------------------
// StreamWatchdog 类
// ---------------------------------------------------------------------------

export class StreamWatchdog {
  private readonly taskId: string;
  private readonly sender: WebContents;
  private readonly heartbeatIntervalMs: number;
  private readonly stallWarningMs: number;
  private readonly hardTimeoutMs: number;
  private readonly abortController?: AbortController;
  private readonly planId?: string;
  private readonly stepId?: number;

  private lastActivityAt: number = Date.now();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private stallWarned = false;
  private stopped = false;

  constructor(options: WatchdogOptions) {
    this.taskId = options.taskId;
    this.sender = options.sender;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 3000;
    this.stallWarningMs = options.stallWarningMs ?? 30_000;
    this.hardTimeoutMs = options.hardTimeoutMs ?? 300_000; // 5 分钟
    this.abortController = options.abortController;
    this.planId = options.planId;
    this.stepId = options.stepId;
  }

  /** 启动监视器。在开始消费流之前调用。 */
  start(): void {
    this.lastActivityAt = Date.now();
    this.stopped = false;
    this.stallWarned = false;

    this.heartbeatTimer = setInterval(() => {
      if (this.stopped || this.sender.isDestroyed()) {
        this.stop();
        return;
      }

      const idleMs = Date.now() - this.lastActivityAt;

      // 硬超时 —— abort 流
      if (idleMs >= this.hardTimeoutMs) {
        console.warn(
          `[Watchdog] Hard timeout (${this.hardTimeoutMs}ms) for task ${this.taskId}`,
        );
        this.sendEvent("stall-timeout", {
          idleMs,
          threshold: this.hardTimeoutMs,
        });

        if (this.abortController && !this.abortController.signal.aborted) {
          this.abortController.abort(
            new Error(`Stream stall timeout after ${this.hardTimeoutMs}ms`),
          );
        }
        this.stop();
        return;
      }

      // 卡死警告 —— 通知渲染进程(仅在状态变化时)
      if (idleMs >= this.stallWarningMs && !this.stallWarned) {
        this.stallWarned = true;
        console.warn(
          `[Watchdog] Stall warning (${idleMs}ms idle) for task ${this.taskId}`,
        );
        this.sendEvent("stall-warning", {
          idleMs,
          threshold: this.stallWarningMs,
        });
      }
    }, this.heartbeatIntervalMs);
  }

  /** 记录流活动 —— 每当一个流分片到达时调用。 */
  activity(): void {
    this.lastActivityAt = Date.now();
    if (this.stallWarned) {
      this.stallWarned = false;
      // 卡死恢复 —— 通知渲染进程
      this.sendEvent("stall-recovered", {});
    }
  }

  /** 停止监视器。在流结束时调用。 */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /** 获取当前空闲时长(毫秒) */
  getIdleMs(): number {
    return Date.now() - this.lastActivityAt;
  }

  private sendEvent(
    type: WatchdogEventType,
    detail: Record<string, unknown>,
  ): void {
    if (this.sender.isDestroyed()) return;
    this.sender.send("ai:watchdog", {
      taskId: this.taskId,
      type,
      planId: this.planId,
      stepId: this.stepId,
      ...detail,
    });
  }
}

// ---------------------------------------------------------------------------
// 步骤超时辅助函数
// ---------------------------------------------------------------------------

/** 步骤级超时的类型化错误 —— 使用 `instanceof` 判断,而非字符串匹配。 */
export class StepTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Step timeout after ${timeoutMs}ms`);
    this.name = "StepTimeoutError";
  }
}

/**
 * 创建一个在 `timeoutMs` 后自动 abort 的 AbortController。
 * 若提供了父 signal,则父级 abort 时子级也会随之 abort。
 * 返回该 controller 与一个清理函数。
 */
export function createTimeoutController(
  timeoutMs: number,
  parentSignal?: AbortSignal,
): { controller: AbortController; cleanup: () => void } {
  const controller = new AbortController();

  const timer = setTimeout(() => {
    if (!controller.signal.aborted) {
      controller.abort(new StepTimeoutError(timeoutMs));
    }
  }, timeoutMs);

  const onParentAbort = () => {
    if (!controller.signal.aborted) {
      controller.abort(parentSignal?.reason);
    }
  };

  if (parentSignal) {
    if (parentSignal.aborted) {
      controller.abort(parentSignal.reason);
    } else {
      parentSignal.addEventListener("abort", onParentAbort, { once: true });
    }
  }

  const cleanup = () => {
    clearTimeout(timer);
    parentSignal?.removeEventListener("abort", onParentAbort);
  };

  return { controller, cleanup };
}
