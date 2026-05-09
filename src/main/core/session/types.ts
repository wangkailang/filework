/**
 * JSONL session-store types.
 *
 * Two on-disk record kinds (discriminated by `kind`) plus the public
 * IPC-shaped types that map 1:1 to the renderer's `ChatSession` /
 * `ChatMessage` (mirrored in `src/renderer/components/chat/types.ts`).
 */

import type { MessagePart } from "./message-parts";

export type SessionFileRecord = SessionLine | MessageLine;

/**
 * Always the first line of a session JSONL file. Carries session
 * metadata; `forkFrom*` fields are stored on disk for lineage but
 * stripped at the `listSessions()` boundary so the IPC return shape
 * stays identical to the SQLite-era one.
 */
export interface SessionLine {
  kind: "session";
  schemaVersion: 1;
  id: string;
  workspacePath: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  forkFromSessionId?: string;
  forkFromMessageId?: string;
}

/** Lines 2..N. One per chat message in timestamp order. */
export interface MessageLine {
  kind: "message";
  id: string;
  sessionId: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  /** Native objects on disk — not JSON.stringified. */
  parts?: MessagePart[];
}

// ─── Public IPC-shaped types ────────────────────────────────────────
// Mirror src/renderer/components/chat/types.ts:90-96 exactly. Kept in
// core so the future SDK and the IPC layer share the same shape.

export interface ChatSession {
  id: string;
  workspacePath: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  parts?: MessagePart[];
}
