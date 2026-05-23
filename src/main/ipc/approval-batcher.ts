// Batched destructive-tool approval buffer. Coalesces N concurrent
// requestApproval() calls for the same (taskId, toolName) into a single
// IPC event so the renderer can show one card with N entries.

import { randomUUID } from "node:crypto";
import type { WebContents } from "electron";
import { dispatchPreview, PREVIEW_TIMEOUT_MS } from "../core/agent/preview";
import { rememberPreview } from "../core/agent/preview/snapshot-store";
import type { ToolPreview } from "../core/agent/preview/types";
import type { Workspace } from "../core/workspace/types";
import { whitelistToolForTask } from "./ai-task-control";

/**
 * Time to wait for additional entries after the latest arrival, before
 * flushing. AI-SDK's parallel-tool dispatch ends up staggered because
 * each `beforeToolCall` runs filesystem checks (realpath() in
 * isInWorkspace) before reaching enqueueForBatch — so 6 parallel
 * deleteFile calls can arrive at the batcher 30-150ms apart depending
 * on FS load. 250ms gives reliable coalescing without noticeably
 * delaying the approval dialog.
 */
const DEBOUNCE_MS = 250;
/** Hard cap on how long a buffer may stay open even if entries keep arriving. */
const MAX_BUFFER_AGE_MS = 10_000;

export interface BatchEntry {
  toolCallId: string;
  args: unknown;
  description: string;
  resolve: (approved: boolean) => void;
  abortSignal?: AbortSignal;
  onAbort?: () => void;
  /**
   * Structured change preview. Populated by PR2's preview generator
   * during `flushBuffer`; PR1 only wires the field through (always
   * undefined).
   */
  preview?: ToolPreview;
}

interface PendingBuffer {
  sender: WebContents;
  taskId: string;
  toolName: string;
  entries: BatchEntry[];
  debounceTimer: ReturnType<typeof setTimeout>;
  capTimer: ReturnType<typeof setTimeout>;
  /**
   * Workspace that owns this task. Captured from the first enqueue with
   * a workspace; used by `flushBuffer` to enrich entries with structured
   * previews before the IPC event is sent. Unset → preview generation
   * is skipped and the event is sent synchronously (legacy path used by
   * unit tests and any caller that hasn't been threaded through yet).
   */
  workspace?: Workspace;
}

export interface PendingBatch {
  sender: WebContents;
  taskId: string;
  toolName: string;
  entries: BatchEntry[];
}

// Buffers awaiting debounce flush. Key = `${taskId}::${toolName}`.
const buffers = new Map<string, PendingBuffer>();
// Flushed batches awaiting user response. Key = batchId.
const pendingBatches = new Map<string, PendingBatch>();

const bufferKey = (taskId: string, toolName: string): string =>
  `${taskId}::${toolName}`;

export interface EnqueueParams {
  sender: WebContents;
  taskId: string;
  toolName: string;
  toolCallId: string;
  args: unknown;
  description: string;
  abortSignal?: AbortSignal;
  /** Optional pre-computed preview. When omitted and `workspace` is
   *  present, the batcher generates one in `flushBuffer`. */
  preview?: ToolPreview;
  /** Workspace that owns this task. Required for the batcher to
   *  generate a preview when none is pre-computed. */
  workspace?: Workspace;
}

/**
 * Buffer this destructive-tool approval request. The returned Promise
 * resolves when the user makes a decision on the containing batch (or
 * the abort signal fires, in which case it resolves to `false`).
 */
export function enqueueForBatch(params: EnqueueParams): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const entry: BatchEntry = {
      toolCallId: params.toolCallId,
      args: params.args,
      description: params.description,
      resolve,
      abortSignal: params.abortSignal,
      preview: params.preview,
    };

    if (params.abortSignal) {
      if (params.abortSignal.aborted) {
        resolve(false);
        return;
      }
      const onAbort = () => {
        removeEntry(params.taskId, params.toolName, entry.toolCallId);
        resolve(false);
      };
      entry.onAbort = onAbort;
      params.abortSignal.addEventListener("abort", onAbort, { once: true });
    }

    const key = bufferKey(params.taskId, params.toolName);
    let buf = buffers.get(key);
    if (!buf) {
      buf = createBuffer(
        params.sender,
        params.taskId,
        params.toolName,
        params.workspace,
      );
      buffers.set(key, buf);
    } else if (!buf.workspace && params.workspace) {
      buf.workspace = params.workspace;
    }
    buf.entries.push(entry);
    // Bump debounce window — additional concurrent arrivals reset the
    // timer so we wait for the wave to finish.
    clearTimeout(buf.debounceTimer);
    buf.debounceTimer = setTimeout(() => flushBuffer(key), DEBOUNCE_MS);
  });
}

function createBuffer(
  sender: WebContents,
  taskId: string,
  toolName: string,
  workspace?: Workspace,
): PendingBuffer {
  const key = bufferKey(taskId, toolName);
  const buf: PendingBuffer = {
    sender,
    taskId,
    toolName,
    entries: [],
    debounceTimer: setTimeout(() => flushBuffer(key), DEBOUNCE_MS),
    capTimer: setTimeout(() => flushBuffer(key), MAX_BUFFER_AGE_MS),
    workspace,
  };
  return buf;
}

function removeEntry(
  taskId: string,
  toolName: string,
  toolCallId: string,
): void {
  const key = bufferKey(taskId, toolName);
  const buf = buffers.get(key);
  if (buf) {
    const idx = buf.entries.findIndex((e) => e.toolCallId === toolCallId);
    if (idx !== -1) buf.entries.splice(idx, 1);
    if (buf.entries.length === 0) {
      clearTimeout(buf.debounceTimer);
      clearTimeout(buf.capTimer);
      buffers.delete(key);
    }
    return;
  }
  for (const batch of pendingBatches.values()) {
    if (batch.taskId === taskId && batch.toolName === toolName) {
      const idx = batch.entries.findIndex((e) => e.toolCallId === toolCallId);
      if (idx !== -1) batch.entries.splice(idx, 1);
      return;
    }
  }
}

function flushBuffer(key: string): void {
  const buf = buffers.get(key);
  if (!buf) return;
  clearTimeout(buf.debounceTimer);
  clearTimeout(buf.capTimer);
  buffers.delete(key);
  if (buf.entries.length === 0) return;

  const batchId = randomUUID();
  pendingBatches.set(batchId, {
    sender: buf.sender,
    taskId: buf.taskId,
    toolName: buf.toolName,
    entries: buf.entries,
  });

  // With a workspace, enrich entries asynchronously then send. Without
  // one (eg unit tests, legacy callers), preserve the synchronous IPC
  // path so existing fake-timer tests don't need microtask flushing.
  if (buf.workspace) {
    void enrichAndSend(buf, batchId);
  } else {
    sendBatchApproval(buf, batchId);
  }
}

function sendBatchApproval(buf: PendingBuffer, batchId: string): void {
  if (buf.sender.isDestroyed()) return;
  buf.sender.send("ai:stream-tool-batch-approval", {
    id: buf.taskId,
    batchId,
    toolName: buf.toolName,
    entries: buf.entries.map((e) => ({
      toolCallId: e.toolCallId,
      args: e.args,
      description: e.description,
      preview: e.preview,
    })),
  });
}

async function enrichAndSend(
  buf: PendingBuffer,
  batchId: string,
): Promise<void> {
  const workspace = buf.workspace;
  if (!workspace) {
    sendBatchApproval(buf, batchId);
    return;
  }
  await Promise.all(
    buf.entries.map(async (e) => {
      if (e.preview !== undefined) return;
      try {
        const preview = await Promise.race([
          dispatchPreview(buf.toolName, e.args, workspace),
          new Promise<undefined>((resolve) => {
            setTimeout(() => resolve(undefined), PREVIEW_TIMEOUT_MS);
          }),
        ]);
        e.preview = preview;
      } catch {
        // dispatchPreview already swallows its own errors; nothing to do.
      }
    }),
  );
  sendBatchApproval(buf, batchId);
}

/**
 * Resolve every entry in the batch with the given decision. When
 * approved, whitelist the toolName so future single-shot calls in the
 * same task bypass the dialog (matches existing whitelist semantics)
 * AND cascade-approve any sibling batches for the same (task, toolName)
 * that flushed separately due to timing jitter — user clicked once,
 * shouldn't have to click again.
 */
export function settleBatch(batchId: string, approved: boolean): boolean {
  const batch = pendingBatches.get(batchId);
  if (!batch) return false;
  pendingBatches.delete(batchId);
  for (const entry of batch.entries) {
    if (entry.abortSignal && entry.onAbort) {
      entry.abortSignal.removeEventListener("abort", entry.onAbort);
    }
    if (approved && entry.preview) {
      // Hand the freshly-generated preview off to the snapshot store so
      // the upcoming `tool_execution_start` IPC can ship it to the
      // renderer without a redundant disk read.
      rememberPreview(entry.toolCallId, entry.preview);
    }
    entry.resolve(approved);
  }
  if (approved) {
    whitelistToolForTask(batch.taskId, batch.toolName);
    cascadeApproveSiblings(batch.taskId, batch.toolName, batch.sender);
  }
  return true;
}

/**
 * After a batch is approved, resolve any other pending batches for the
 * same (taskId, toolName) and emit a notification IPC event so the
 * renderer can collapse their cards into the accepted state.
 */
function cascadeApproveSiblings(
  taskId: string,
  toolName: string,
  sender: WebContents,
): void {
  for (const [batchId, batch] of pendingBatches) {
    if (batch.taskId !== taskId || batch.toolName !== toolName) continue;
    pendingBatches.delete(batchId);
    for (const entry of batch.entries) {
      if (entry.abortSignal && entry.onAbort) {
        entry.abortSignal.removeEventListener("abort", entry.onAbort);
      }
      if (entry.preview) rememberPreview(entry.toolCallId, entry.preview);
      entry.resolve(true);
    }
    if (!sender.isDestroyed()) {
      sender.send("ai:stream-tool-batch-auto-approved", {
        id: taskId,
        batchId,
      });
    }
  }
}

/**
 * Reject every entry (still-buffering or already-flushed) belonging to
 * the given task. Used by `stopTaskExecution`.
 */
export function cancelBatchesForTask(taskId: string): void {
  for (const [key, buf] of buffers) {
    if (buf.taskId !== taskId) continue;
    clearTimeout(buf.debounceTimer);
    clearTimeout(buf.capTimer);
    for (const entry of buf.entries) {
      if (entry.abortSignal && entry.onAbort) {
        entry.abortSignal.removeEventListener("abort", entry.onAbort);
      }
      entry.resolve(false);
    }
    buffers.delete(key);
  }
  for (const [batchId, batch] of pendingBatches) {
    if (batch.taskId !== taskId) continue;
    for (const entry of batch.entries) {
      if (entry.abortSignal && entry.onAbort) {
        entry.abortSignal.removeEventListener("abort", entry.onAbort);
      }
      entry.resolve(false);
    }
    pendingBatches.delete(batchId);
  }
}

/** Test helper. */
export function __resetBatcherForTests(): void {
  for (const buf of buffers.values()) {
    clearTimeout(buf.debounceTimer);
    clearTimeout(buf.capTimer);
  }
  buffers.clear();
  pendingBatches.clear();
}

/** Inspection helper for tests. */
export function __getBatcherState(): {
  bufferCount: number;
  pendingBatchCount: number;
} {
  return {
    bufferCount: buffers.size,
    pendingBatchCount: pendingBatches.size,
  };
}

/**
 * Test helper: synchronously flush every still-buffering batch (skipping
 * the debounce wait). Returns the list of batchIds that got flushed.
 */
export function __flushAllForTests(): string[] {
  const flushedIds: string[] = [];
  const keys = Array.from(buffers.keys());
  for (const key of keys) {
    const before = pendingBatches.size;
    flushBuffer(key);
    if (pendingBatches.size > before) {
      const id = Array.from(pendingBatches.keys()).pop();
      if (id) flushedIds.push(id);
    }
  }
  return flushedIds;
}

/**
 * Test helper: locate the batch containing the given toolCallId and
 * settle it. Includes still-buffering entries (flushes them first).
 */
export function __settleByToolCallIdForTests(
  toolCallId: string,
  approved: boolean,
): boolean {
  for (const [key, buf] of buffers) {
    if (buf.entries.some((e) => e.toolCallId === toolCallId)) {
      flushBuffer(key);
      break;
    }
  }
  for (const [batchId, batch] of pendingBatches) {
    if (batch.entries.some((e) => e.toolCallId === toolCallId)) {
      return settleBatch(batchId, approved);
    }
  }
  return false;
}
