/**
 * JSONL 会话存储类型定义。
 *
 * 包含两种磁盘记录类型(通过 `kind` 区分),以及面向 IPC 的公开类型,
 * 它们与渲染进程的 `ChatSession` / `ChatMessage` 一一对应
 * (镜像于 `src/renderer/components/chat/types.ts`)。
 */

import type { MessagePart } from "./message-parts";

export type SessionFileRecord = SessionLine | MessageLine;

/**
 * 始终是会话 JSONL 文件的第一行。携带会话元数据;
 * `forkFrom*` 字段会存储到磁盘以记录派生关系,但在 `listSessions()`
 * 边界处会被剥离,从而使 IPC 返回结构与 SQLite 时代保持一致。
 */
export interface SessionLine {
  kind: "session";
  schemaVersion: 1;
  id: string;
  workspacePath: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  /** 该会话最后一次发送消息时所在的活动分支。 */
  lastActiveBranch?: string | null;
  forkFromSessionId?: string;
  forkFromMessageId?: string;
}

/** 第 2 到 N 行。按时间戳顺序每条聊天消息一行。 */
export interface MessageLine {
  kind: "message";
  id: string;
  sessionId: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  /** 磁盘上为原生对象 —— 未经 JSON.stringify 序列化。 */
  parts?: MessagePart[];
}

// ─── 面向 IPC 的公开类型 ────────────────────────────────────────
// 与 src/renderer/components/chat/types.ts:90-96 完全一致。保留在
// core 中,使未来的 SDK 与 IPC 层共享同一结构。

export interface ChatSession {
  id: string;
  workspacePath: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  lastActiveBranch?: string | null;
  automationRun?: {
    id: string;
    automationId: string;
    title: string;
  };
}

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  parts?: MessagePart[];
}
