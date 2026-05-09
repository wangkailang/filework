/**
 * One-shot SQLite → JSONL chat migration.
 *
 * Runs synchronously on app startup, before chat IPC handlers register
 * (see `src/main/index.ts`). Idempotent: skips any session whose target
 * JSONL file already exists.
 *
 * Design notes:
 * - The atomic-write helper from `JsonlSessionStore.atomicWrite()` is
 *   reused so a crash mid-migration leaves either the previous (absent)
 *   state or a complete file — never a partial one.
 * - SQLite's `chat_messages.parts` is `JSON.stringify`d (db/index.ts:696);
 *   `getChatHistory` already parses it back, so we forward parsed objects
 *   directly into JSONL.
 * - Per-session errors are collected and returned; we never crash the app
 *   for a corrupt session.
 */

import { access } from "node:fs/promises";
import path from "node:path";

import type { JsonlSessionStore } from "../core/session/jsonl-store";
import type { MessagePart } from "../core/session/message-parts";
import type {
  MessageLine,
  SessionFileRecord,
  SessionLine,
} from "../core/session/types";
import { workspaceKey } from "../core/session/workspace-key";
import { getAllChatSessionsForMigration, getChatHistory } from "./index";

/** Shape returned by `getChatHistory` — `parts` is loosely typed in the legacy db layer. */
type LegacyChatMessage = ReturnType<typeof getChatHistory>[number];

export interface MigrationReport {
  migrated: number;
  skipped: number;
  errors: { sessionId: string; reason: string }[];
}

const renderRecords = (records: SessionFileRecord[]): string =>
  `${records.map((r) => JSON.stringify(r)).join("\n")}\n`;

export async function migrateChatToJsonl(
  store: JsonlSessionStore,
): Promise<MigrationReport> {
  const report: MigrationReport = { migrated: 0, skipped: 0, errors: [] };

  let sessions: ReturnType<typeof getAllChatSessionsForMigration>;
  try {
    sessions = getAllChatSessionsForMigration();
  } catch (err) {
    // Source DB unreadable — most likely tables don't exist yet on a
    // fresh install. Treat as "nothing to migrate".
    console.warn(
      "[migration] could not read chat_sessions; skipping migration:",
      err instanceof Error ? err.message : err,
    );
    return report;
  }

  if (sessions.length === 0) {
    console.log("[migration] no chat sessions to migrate");
    return report;
  }

  for (const s of sessions) {
    try {
      const targetPath = await store.targetPath(s.workspacePath, s.id);

      // Idempotency check — if the file already exists, the session has
      // been migrated previously. Don't overwrite.
      try {
        await access(targetPath);
        report.skipped++;
        continue;
      } catch {
        // ENOENT — proceed with migration.
      }

      const messages = getChatHistory(s.id);

      const sessionLine: SessionLine = {
        kind: "session",
        schemaVersion: 1,
        id: s.id,
        workspacePath: s.workspacePath,
        title: s.title,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
      };
      // Fork lineage lives on the SQLite ChatSession row but isn't on the
      // exported `ChatSession` type. SELECT * returns it; pick it up via
      // index access if present.
      const sourceUnknown = s as unknown as Record<string, unknown>;
      if (typeof sourceUnknown.forkFromSessionId === "string") {
        sessionLine.forkFromSessionId = sourceUnknown.forkFromSessionId;
      }
      if (typeof sourceUnknown.forkFromMessageId === "string") {
        sessionLine.forkFromMessageId = sourceUnknown.forkFromMessageId;
      }

      const messageLines: MessageLine[] = messages.map(
        (m: LegacyChatMessage): MessageLine => ({
          kind: "message",
          id: m.id,
          sessionId: s.id,
          role: m.role,
          content: m.content,
          timestamp: m.timestamp,
          // Parts were stringified into SQLite at db/index.ts:696 and
          // parsed back to objects in getChatHistory; the legacy type
          // is loose (`unknown[]`), so cast to the strict union here.
          parts: m.parts as MessagePart[] | undefined,
        }),
      );

      await store.atomicWrite(
        targetPath,
        renderRecords([sessionLine, ...messageLines]),
      );
      report.migrated++;

      if (report.migrated === 1) {
        console.log(
          `[migration] writing JSONL under workspace key ${workspaceKey(s.workspacePath)} → ${path.dirname(targetPath)}`,
        );
      }
    } catch (err) {
      report.errors.push({
        sessionId: s.id,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  console.log(
    `[migration] migrated ${report.migrated} sessions, skipped ${report.skipped}, errors ${report.errors.length}`,
  );
  return report;
}
