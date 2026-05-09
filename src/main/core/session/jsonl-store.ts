/**
 * JsonlSessionStore — file-backed chat session persistence.
 *
 * Layout: <rootDir>/<workspaceKey>/<sessionId>.jsonl
 *   - line 1: SessionLine (always)
 *   - lines 2..N: MessageLine in timestamp order
 *   - trailing newline, UTF-8
 *
 * All mutations write to a `.tmp` sibling and atomically rename over the
 * target. Crash mid-write leaves either the previous valid file or an
 * orphan `.tmp`; orphans are cleaned by `cleanupOrphanTmp()` (called from
 * the lazy session→workspace index build).
 *
 * Pure Node — no Electron, no SQLite, no Drizzle. Safe for the future
 * headless SDK to import directly.
 */

import { randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import path from "node:path";

import type {
  ChatMessage,
  ChatSession,
  MessageLine,
  SessionFileRecord,
  SessionLine,
} from "./types";
import { workspaceKey } from "./workspace-key";

const SESSION_FILE_EXT = ".jsonl";
const TMP_FILE_EXT = ".jsonl.tmp";

// ─── Helpers ────────────────────────────────────────────────────────

const stripForkFields = (line: SessionLine): ChatSession => ({
  id: line.id,
  workspacePath: line.workspacePath,
  title: line.title,
  createdAt: line.createdAt,
  updatedAt: line.updatedAt,
});

const lineToMessage = (line: MessageLine): ChatMessage => ({
  id: line.id,
  sessionId: line.sessionId,
  role: line.role,
  content: line.content,
  timestamp: line.timestamp,
  parts: line.parts,
});

const renderRecords = (records: SessionFileRecord[]): string =>
  `${records.map((r) => JSON.stringify(r)).join("\n")}\n`;

const parseLines = (raw: string): SessionFileRecord[] => {
  const out: SessionFileRecord[] = [];
  const lines = raw.split("\n");
  for (const ln of lines) {
    if (!ln.trim()) continue;
    try {
      out.push(JSON.parse(ln) as SessionFileRecord);
    } catch {
      // Skip malformed lines; we'd rather lose one record than the file.
    }
  }
  return out;
};

// ─── Class ──────────────────────────────────────────────────────────

interface SessionLocation {
  workspaceKey: string;
  filePath: string;
}

export class JsonlSessionStore {
  private indexBuilt = false;
  private indexBuilding: Promise<void> | null = null;
  /** sessionId → { workspaceKey, filePath } */
  private readonly sessionIndex = new Map<string, SessionLocation>();

  constructor(private readonly rootDir: string) {}

  // ─── Public API (1:1 with chat:* IPC) ─────────────────────────────

  async createSession(
    workspacePath: string,
    title?: string,
  ): Promise<ChatSession> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const sessionLine: SessionLine = {
      kind: "session",
      schemaVersion: 1,
      id,
      workspacePath,
      title: title ?? "新对话",
      createdAt: now,
      updatedAt: now,
    };
    const filePath = await this.targetPath(workspacePath, id);
    await this.atomicWrite(filePath, renderRecords([sessionLine]));
    this.sessionIndex.set(id, {
      workspaceKey: workspaceKey(workspacePath),
      filePath,
    });
    return stripForkFields(sessionLine);
  }

  async listSessions(workspacePath: string): Promise<ChatSession[]> {
    const dir = path.join(this.rootDir, workspaceKey(workspacePath));
    const entries = await this.readdirSafe(dir);
    const sessions: ChatSession[] = [];
    for (const name of entries) {
      if (!name.endsWith(SESSION_FILE_EXT)) continue;
      const fp = path.join(dir, name);
      const head = await this.readFirstSessionLine(fp);
      if (head) {
        sessions.push(stripForkFields(head));
        // Opportunistically populate the index.
        this.sessionIndex.set(head.id, {
          workspaceKey: workspaceKey(workspacePath),
          filePath: fp,
        });
      }
    }
    sessions.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    return sessions;
  }

  async updateSession(
    sessionId: string,
    updates: Partial<Pick<ChatSession, "title" | "updatedAt">>,
  ): Promise<void> {
    const loc = await this.locate(sessionId);
    if (!loc) return;
    const records = await this.readAllRecords(loc.filePath);
    const sessionLine = records[0];
    if (!sessionLine || sessionLine.kind !== "session") return;
    if (updates.title !== undefined) sessionLine.title = updates.title;
    sessionLine.updatedAt = updates.updatedAt ?? new Date().toISOString();
    await this.atomicWrite(loc.filePath, renderRecords(records));
  }

  async deleteSession(sessionId: string): Promise<void> {
    const loc = await this.locate(sessionId);
    if (!loc) return;
    try {
      await unlink(loc.filePath);
    } catch {
      // Already gone; ignore.
    }
    this.sessionIndex.delete(sessionId);
  }

  async forkSession(
    sessionId: string,
    fromMessageId: string,
  ): Promise<ChatSession> {
    const loc = await this.locate(sessionId);
    if (!loc) throw new Error("源会话不存在");
    const records = await this.readAllRecords(loc.filePath);
    const sourceSession = records[0];
    if (!sourceSession || sourceSession.kind !== "session") {
      throw new Error("源会话文件已损坏");
    }

    const messages = records.filter(
      (r): r is MessageLine => r.kind === "message",
    );
    const forkIdx = messages.findIndex((m) => m.id === fromMessageId);
    if (forkIdx === -1) throw new Error("分叉点消息不存在");
    const messagesToCopy = messages.slice(0, forkIdx + 1);

    const newId = randomUUID();
    const now = new Date().toISOString();
    const newSession: SessionLine = {
      kind: "session",
      schemaVersion: 1,
      id: newId,
      workspacePath: sourceSession.workspacePath,
      title: `${sourceSession.title} (分支)`,
      createdAt: now,
      updatedAt: now,
      forkFromSessionId: sourceSession.id,
      forkFromMessageId: fromMessageId,
    };
    const copiedMessages: MessageLine[] = messagesToCopy.map((m) => ({
      kind: "message",
      id: randomUUID(),
      sessionId: newId,
      role: m.role,
      content: m.content,
      timestamp: m.timestamp,
      parts: m.parts,
    }));

    const newFilePath = await this.targetPath(
      sourceSession.workspacePath,
      newId,
    );
    await this.atomicWrite(
      newFilePath,
      renderRecords([newSession, ...copiedMessages]),
    );
    this.sessionIndex.set(newId, {
      workspaceKey: workspaceKey(sourceSession.workspacePath),
      filePath: newFilePath,
    });

    return stripForkFields(newSession);
  }

  async getMessages(sessionId: string): Promise<ChatMessage[]> {
    const loc = await this.locate(sessionId);
    if (!loc) return [];
    const records = await this.readAllRecords(loc.filePath);
    const out: ChatMessage[] = [];
    for (const r of records) {
      if (r.kind === "message") out.push(lineToMessage(r));
    }
    out.sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1));
    return out;
  }

  async saveMessages(
    sessionId: string,
    workspacePath: string,
    messages: ChatMessage[],
  ): Promise<void> {
    const loc = await this.locate(sessionId);
    let sessionLine: SessionLine;
    let filePath: string;
    if (loc) {
      const records = await this.readAllRecords(loc.filePath);
      const head = records[0];
      if (head && head.kind === "session") {
        sessionLine = head;
      } else {
        // Corrupt header — synthesize a fresh one rather than lose the save.
        sessionLine = {
          kind: "session",
          schemaVersion: 1,
          id: sessionId,
          workspacePath,
          title: "新对话",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
      }
      filePath = loc.filePath;
    } else {
      // First save for a session created elsewhere — synthesize its header.
      sessionLine = {
        kind: "session",
        schemaVersion: 1,
        id: sessionId,
        workspacePath,
        title: "新对话",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      filePath = await this.targetPath(workspacePath, sessionId);
      this.sessionIndex.set(sessionId, {
        workspaceKey: workspaceKey(workspacePath),
        filePath,
      });
    }

    sessionLine.updatedAt = new Date().toISOString();

    const messageLines: MessageLine[] = messages.map((m) => ({
      kind: "message",
      id: m.id,
      sessionId,
      role: m.role,
      content: m.content,
      timestamp: m.timestamp,
      parts: m.parts,
    }));

    await this.atomicWrite(
      filePath,
      renderRecords([sessionLine, ...messageLines]),
    );
  }

  // ─── Atomic write helper (also used by migration) ─────────────────

  /**
   * Write `content` to `filePath` atomically. Creates parent dirs if
   * needed. Public so the migration module can reuse the same atomicity
   * guarantees.
   */
  async atomicWrite(filePath: string, content: string): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.tmp`;
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      handle = await open(tmpPath, "w");
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      if (handle) await handle.close();
    }
    await rename(tmpPath, filePath);
  }

  /** Compute the target file path for `(workspacePath, sessionId)`. */
  async targetPath(workspacePath: string, sessionId: string): Promise<string> {
    const dir = path.join(this.rootDir, workspaceKey(workspacePath));
    return path.join(dir, `${sessionId}${SESSION_FILE_EXT}`);
  }

  // ─── Internals ────────────────────────────────────────────────────

  /** Lazily build the sessionId → location index from disk. */
  private async ensureIndex(): Promise<void> {
    if (this.indexBuilt) return;
    if (this.indexBuilding) return this.indexBuilding;
    this.indexBuilding = (async () => {
      try {
        await this.assertRootIsDirectory();
        const workspaces = await this.readdirSafe(this.rootDir);
        for (const wk of workspaces) {
          const wsDir = path.join(this.rootDir, wk);
          const files = await this.readdirSafe(wsDir);
          for (const file of files) {
            if (file.endsWith(TMP_FILE_EXT)) {
              // Orphan from a crashed write — remove.
              await rm(path.join(wsDir, file), { force: true });
              continue;
            }
            if (!file.endsWith(SESSION_FILE_EXT)) continue;
            const fp = path.join(wsDir, file);
            const head = await this.readFirstSessionLine(fp);
            if (head) {
              this.sessionIndex.set(head.id, {
                workspaceKey: wk,
                filePath: fp,
              });
            }
          }
        }
      } finally {
        this.indexBuilt = true;
        this.indexBuilding = null;
      }
    })();
    return this.indexBuilding;
  }

  /** Resolve a sessionId to its on-disk location. Builds the index lazily. */
  private async locate(sessionId: string): Promise<SessionLocation | null> {
    if (this.sessionIndex.has(sessionId)) {
      return this.sessionIndex.get(sessionId) ?? null;
    }
    await this.ensureIndex();
    return this.sessionIndex.get(sessionId) ?? null;
  }

  private async readAllRecords(filePath: string): Promise<SessionFileRecord[]> {
    try {
      const raw = await readFile(filePath, "utf8");
      return parseLines(raw);
    } catch {
      return [];
    }
  }

  private async readFirstSessionLine(
    filePath: string,
  ): Promise<SessionLine | null> {
    try {
      const raw = await readFile(filePath, "utf8");
      const newlineIdx = raw.indexOf("\n");
      const firstLine = newlineIdx === -1 ? raw : raw.slice(0, newlineIdx);
      if (!firstLine.trim()) return null;
      const parsed = JSON.parse(firstLine) as SessionFileRecord;
      return parsed.kind === "session" ? parsed : null;
    } catch (err) {
      console.warn(
        `[JsonlSessionStore] Skipping corrupt session file ${filePath}:`,
        err instanceof Error ? err.message : err,
      );
      return null;
    }
  }

  private async readdirSafe(dir: string): Promise<string[]> {
    try {
      return await readdir(dir);
    } catch {
      return [];
    }
  }

  private async assertRootIsDirectory(): Promise<void> {
    try {
      await access(this.rootDir);
    } catch {
      // Doesn't exist yet — that's fine, we'll create dirs on first write.
      return;
    }
    // Exists — make sure it's a directory.
    try {
      await readdir(this.rootDir);
    } catch (err) {
      throw new Error(
        `[JsonlSessionStore] Path ${this.rootDir} exists but is not a readable directory: ${
          err instanceof Error ? err.message : err
        }`,
      );
    }
  }
}
