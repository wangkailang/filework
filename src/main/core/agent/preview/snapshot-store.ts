/**
 * In-memory store mapping `toolCallId → ToolPreview`. The approval
 * batcher remembers each entry's freshly-generated preview when the
 * user approves; the tool-execution-start IPC bridge consumes the
 * snapshot and ships it to the renderer alongside the tool args. This
 * lets the post-apply tool card render the exact diff the user saw on
 * the approval card without re-reading the (now overwritten) pre-image.
 *
 * Process-local; no persistence. Bounded LRU so a never-claimed
 * approval doesn't leak indefinitely.
 */

import type { ToolPreview } from "./types";

const LRU_MAX = 64;
const store = new Map<string, ToolPreview>();

/** Save a snapshot keyed by toolCallId. Replaces any prior entry. */
export function rememberPreview(
  toolCallId: string,
  preview: ToolPreview,
): void {
  if (store.size >= LRU_MAX && !store.has(toolCallId)) {
    const oldest = store.keys().next().value;
    if (oldest !== undefined) store.delete(oldest);
  }
  store.set(toolCallId, preview);
}

/** Retrieve and remove the snapshot for the given toolCallId. */
export function consumePreview(toolCallId: string): ToolPreview | undefined {
  const v = store.get(toolCallId);
  if (v !== undefined) store.delete(toolCallId);
  return v;
}

/** Test helper. */
export function __resetSnapshotStore(): void {
  store.clear();
}
