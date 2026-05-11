/**
 * CI Watcher (M12).
 *
 * After M9/M11 the agent can trigger CI runs (rerun, dispatch) but it has
 * to keep calling `listCIRuns` to know when one finishes — burning LLM
 * turns or relying on the user to ask "is it done yet?".
 *
 * This module runs the polling loop in the main process instead. After a
 * rerun is approved, `agent-tools.ts` calls `ciWatcher.subscribe(...)`;
 * every TICK_MS the watcher fetches `getCIRun({id: runId})` and emits an
 * `ai:ci-run-done` IPC event the moment the run terminates. The renderer
 * surfaces it inline in the chat.
 *
 * State is in-memory. App restart drops watches; agents can re-list to
 * recover. Module-level singleton because IPC handlers in different files
 * need to reach the same Map of in-flight watches.
 */

import type { WebContents } from "electron";

import type { Workspace } from "../core/workspace/types";

export const TICK_MS = 30_000;
export const TIMEOUT_MS = 5 * 60_000;
/** M13: how long between listCIRuns retries when resolving a dispatched run. */
export const RESOLVE_RETRY_MS = 2_000;
/** M13: max attempts to resolve a dispatched run's id (~6s budget). */
export const RESOLVE_MAX_ATTEMPTS = 3;

export interface SubscribeInput {
  workspace: Workspace;
  runId: string;
  sender: WebContents;
  taskId: string;
  signal: AbortSignal;
}

export interface DispatchSubscribeInput {
  workspace: Workspace;
  ref: string;
  workflowFile: string;
  sender: WebContents;
  taskId: string;
  signal: AbortSignal;
}

interface WatchEntry {
  workspaceId: string;
  runId: string;
  taskId: string;
  startedAt: number;
  intervalId: ReturnType<typeof setInterval>;
  timeoutId: ReturnType<typeof setTimeout>;
  signal: AbortSignal;
  abortListener: () => void;
}

class CiWatcher {
  private readonly entries = new Map<string, WatchEntry>();

  /**
   * Subscribe to a CI run. Returns the watch key, or null when the
   * workspace can't poll (no `getCIRun` SCM method). Calling twice with
   * the same `${workspace.id}:${runId}` key dedupes — only one watcher
   * per run, regardless of how many reruns the agent has approved.
   */
  subscribe(input: SubscribeInput): string | null {
    const getCIRun = input.workspace.scm?.getCIRun;
    if (!getCIRun) return null;

    const watchKey = `${input.workspace.id}:${input.runId}`;
    if (this.entries.has(watchKey)) return watchKey;

    const tick = async () => {
      if (input.sender.isDestroyed() || input.signal.aborted) {
        this.unsubscribe(watchKey);
        return;
      }
      try {
        const detail = await getCIRun.call(input.workspace.scm, {
          id: input.runId,
        });
        if (detail.status === "completed") {
          if (!input.sender.isDestroyed()) {
            input.sender.send("ai:ci-run-done", {
              id: input.taskId,
              runId: input.runId,
              workspaceId: input.workspace.id,
              conclusion: detail.conclusion,
              url: detail.url,
              name: detail.name,
              durationSec: detail.durationSec,
            });
          }
          this.unsubscribe(watchKey);
        }
      } catch (err) {
        // Network blip — wait for next tick. Don't unsubscribe.
        console.warn(
          `[ci-watcher] tick error for ${watchKey}:`,
          err instanceof Error ? err.message : err,
        );
      }
    };

    const intervalId = setInterval(tick, TICK_MS);

    const timeoutId = setTimeout(() => {
      if (!input.sender.isDestroyed()) {
        input.sender.send("ai:ci-run-timeout", {
          id: input.taskId,
          runId: input.runId,
          workspaceId: input.workspace.id,
          elapsedMs: TIMEOUT_MS,
        });
      }
      this.unsubscribe(watchKey);
    }, TIMEOUT_MS);

    const abortListener = () => this.unsubscribe(watchKey);
    input.signal.addEventListener("abort", abortListener, { once: true });

    this.entries.set(watchKey, {
      workspaceId: input.workspace.id,
      runId: input.runId,
      taskId: input.taskId,
      startedAt: Date.now(),
      intervalId,
      timeoutId,
      signal: input.signal,
      abortListener,
    });
    return watchKey;
  }

  unsubscribe(watchKey: string): void {
    const entry = this.entries.get(watchKey);
    if (!entry) return;
    clearInterval(entry.intervalId);
    clearTimeout(entry.timeoutId);
    entry.signal.removeEventListener("abort", entry.abortListener);
    this.entries.delete(watchKey);
  }

  /**
   * M13: resolve a runId for a just-dispatched workflow (GitHub `/dispatches`
   * returns 204+empty so we don't have one) by polling `listCIRuns({ref,
   * status:"in_progress", limit:1})` up to RESOLVE_MAX_ATTEMPTS times with
   * RESOLVE_RETRY_MS between attempts. On first hit, falls through to
   * subscribe(). On exhaustion, emits ai:ci-dispatch-resolve-failed.
   *
   * Fire-and-forget by callers — don't await this from inside a tool's
   * execute() or you'll block the tool's return for the full retry budget.
   */
  async subscribeAfterDispatch(
    input: DispatchSubscribeInput,
  ): Promise<string | null> {
    const listCIRuns = input.workspace.scm?.listCIRuns;
    if (!listCIRuns) return null;

    for (let attempt = 0; attempt < RESOLVE_MAX_ATTEMPTS; attempt++) {
      if (input.signal.aborted) return null;
      if (attempt > 0) {
        await delay(RESOLVE_RETRY_MS, input.signal);
        if (input.signal.aborted) return null;
      }
      try {
        const runs = await listCIRuns.call(input.workspace.scm, {
          ref: input.ref,
          status: "in_progress",
          limit: 1,
        });
        if (runs.length > 0) {
          const runId = runs[0].id;
          return this.subscribe({
            workspace: input.workspace,
            runId,
            sender: input.sender,
            taskId: input.taskId,
            signal: input.signal,
          });
        }
      } catch (err) {
        console.warn(
          `[ci-watcher] dispatch resolve attempt ${attempt + 1} failed:`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    if (!input.sender.isDestroyed()) {
      input.sender.send("ai:ci-dispatch-resolve-failed", {
        id: input.taskId,
        workspaceId: input.workspace.id,
        ref: input.ref,
        workflowFile: input.workflowFile,
      });
    }
    return null;
  }

  /** Test seam — count of active subscriptions. */
  size(): number {
    return this.entries.size;
  }
}

/** Abort-aware sleep — resolves on either timeout or abort. */
const delay = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const id = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(id);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });

export const ciWatcher = new CiWatcher();

/** Test-only export so tests can build a fresh isolated instance. */
export const __test__ = { CiWatcher };
