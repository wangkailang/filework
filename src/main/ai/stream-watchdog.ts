/**
 * Stream Watchdog — stall detection & timeout for AI streaming.
 *
 * Monitors streaming activity and:
 * 1. Detects stalls (no activity for a configurable duration)
 * 2. Can trigger abort on stall timeout
 */

import type { WebContents } from "electron";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WatchdogEventType =
  | "stall-warning"
  | "stall-recovered"
  | "stall-timeout";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface WatchdogOptions {
  /** Task ID for event correlation */
  taskId: string;
  /** Electron WebContents to send events to */
  sender: WebContents;
  /** Heartbeat interval in ms (default: 3000) */
  heartbeatIntervalMs?: number;
  /** Stall threshold in ms — triggers warning (default: 30000) */
  stallWarningMs?: number;
  /** Hard timeout in ms — triggers abort if set (default: 300000 = 5 min) */
  hardTimeoutMs?: number;
  /** AbortController to trigger on hard timeout */
  abortController?: AbortController;
  /** Plan-specific metadata */
  planId?: string;
  stepId?: number;
}

// ---------------------------------------------------------------------------
// StreamWatchdog class
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
    this.hardTimeoutMs = options.hardTimeoutMs ?? 300_000; // 5 min
    this.abortController = options.abortController;
    this.planId = options.planId;
    this.stepId = options.stepId;
  }

  /** Start the watchdog. Call this before beginning to consume the stream. */
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

      // Hard timeout — abort the stream
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

      // Stall warning — notify renderer (only on state change)
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

  /** Record stream activity — call this every time a stream part arrives. */
  activity(): void {
    this.lastActivityAt = Date.now();
    if (this.stallWarned) {
      this.stallWarned = false;
      // Stall recovered — notify renderer
      this.sendEvent("stall-recovered", {});
    }
  }

  /** Stop the watchdog. Call this when the stream ends. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /** Get the current idle duration in ms */
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
// Step timeout helper
// ---------------------------------------------------------------------------

/** Typed error for step-level timeouts — use `instanceof` instead of string matching. */
export class StepTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Step timeout after ${timeoutMs}ms`);
    this.name = "StepTimeoutError";
  }
}

/**
 * Create an AbortController that auto-aborts after `timeoutMs`.
 * If a parent signal is provided, the child also aborts when the parent does.
 * Returns the controller and a cleanup function.
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
