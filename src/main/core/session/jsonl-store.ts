/**
 * JsonlSessionStore —— 基于文件的聊天会话持久化。
 *
 * 布局:<rootDir>/<workspaceKey>/<sessionId>.jsonl
 *   - 第 1 行:SessionLine(始终存在)
 *   - 第 2..N 行:按时间戳顺序排列的 MessageLine
 *   - 末尾换行,UTF-8
 *
 * 所有写入都先写到一个 `.tmp` 同级文件,再原子地重命名覆盖
 * 目标文件。写入中途崩溃会留下要么是之前的有效文件,要么是
 * 一个孤立的 `.tmp`;孤立文件由 `cleanupOrphanTmp()` 清理(在
 * 惰性构建 会话→工作区 索引时调用)。
 *
 * 纯 Node —— 不依赖 Electron、SQLite、Drizzle。可供未来的
 * 无头 SDK 直接导入。
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

import type { MessagePart } from "./message-parts";
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

// ─── 辅助函数 ───────────────────────────────────────────────────────

const stripForkFields = (line: SessionLine): ChatSession => ({
  id: line.id,
  workspacePath: line.workspacePath,
  title: line.title,
  createdAt: line.createdAt,
  updatedAt: line.updatedAt,
});

/**
 * 丢弃绝不应落盘的瞬态字段:
 *   - `ToolPart.previewSnapshot`  —— 进程本地的快照,用于
 *     注水执行后的 diff;重新加载后已过期,因此持久化
 *     它会在下一次会话误导渲染器。
 *   - `BatchApprovalEntry.preview` —— 同理;仅在 flush 与
 *     settle 之间有意义,此后不再相关。
 *
 * 幂等:不含这些字段的 part 原样透传。
 */
const stripTransientPreview = (parts: MessagePart[]): MessagePart[] =>
  parts.map((part) => {
    if (part.type === "tool" && "previewSnapshot" in part) {
      const { previewSnapshot: _drop, ...rest } = part;
      return rest;
    }
    if (part.type === "batch-approval") {
      return {
        ...part,
        entries: part.entries.map((e) => {
          if (!("preview" in e) || e.preview === undefined) return e;
          const { preview: _p, ...rest } = e;
          return rest;
        }),
      };
    }
    return part;
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
      // 跳过格式错误的行;宁可丢掉一条记录,也不要丢掉整个文件。
    }
  }
  return out;
};

// ─── 类 ─────────────────────────────────────────────────────────────

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

  // ─── 公共 API(与 chat:* IPC 一一对应) ───────────────────────────

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
      const records = await this.readAllRecords(fp);
      const head = records[0];
      if (!head || head.kind !== "session") continue;
      // 跳过从未收到过消息的会话 —— 否则它们会在侧边栏中
      // 显示为点进去什么也没有的记录。
      if (!records.some((r) => r.kind === "message")) continue;
      sessions.push(stripForkFields(head));
      // 顺带填充索引。
      this.sessionIndex.set(head.id, {
        workspaceKey: workspaceKey(workspacePath),
        filePath: fp,
      });
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
      // 已经不存在了;忽略。
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
        // 头部损坏 —— 合成一个新的,而不是丢失这次保存。
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
      // 对在别处创建的会话的首次保存 —— 合成它的头部。
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

    const messageLines: MessageLine[] = messages.map((m) => ({
      kind: "message",
      id: m.id,
      sessionId,
      role: m.role,
      content: m.content,
      timestamp: m.timestamp,
      parts: m.parts ? stripTransientPreview(m.parts) : m.parts,
    }));
    const latestUserMessage = messageLines
      .filter((m) => m.role === "user")
      .reduce<MessageLine | null>(
        (latest, message) =>
          latest == null || message.timestamp > latest.timestamp
            ? message
            : latest,
        null,
      );
    sessionLine.updatedAt =
      latestUserMessage?.timestamp ?? new Date().toISOString();

    await this.atomicWrite(
      filePath,
      renderRecords([sessionLine, ...messageLines]),
    );
  }

  // ─── 原子写入辅助(也供迁移逻辑使用) ────────────────────────────

  /**
   * 原子地将 `content` 写入 `filePath`。必要时创建父目录。
   * 设为 public 以便迁移模块复用同样的原子性保证。
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

  /** 计算 `(workspacePath, sessionId)` 对应的目标文件路径。 */
  async targetPath(workspacePath: string, sessionId: string): Promise<string> {
    const dir = path.join(this.rootDir, workspaceKey(workspacePath));
    return path.join(dir, `${sessionId}${SESSION_FILE_EXT}`);
  }

  // ─── 内部实现 ──────────────────────────────────────────────────────

  /** 从磁盘惰性构建 sessionId → location 索引。 */
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
              // 来自崩溃写入的孤立文件 —— 删除。
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

  /** 将 sessionId 解析为其磁盘位置。惰性构建索引。 */
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
      // 尚不存在 —— 没关系,我们会在首次写入时创建目录。
      return;
    }
    // 存在 —— 确认它是一个目录。
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
