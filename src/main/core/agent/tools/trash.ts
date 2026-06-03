/**
 * 工作区回收站 —— 软删除与恢复。
 *
 * `deleteFile` 不再硬删,而是把目标移动到工作区专属的回收站目录
 * (`~/.filework/trash/<workspaceKey>/`),并在 `index.json` 中记录原始
 * 绝对路径等元数据,使删除可撤销。物理删除改为显式 `emptyTrash`。
 *
 * 该模块直接走宿主 `node:fs`(而非 `workspace.fs`):回收站刻意位于
 * 工作区之外,经 `workspace.fs` 移动会触发沙箱越界保护。调用方传入的
 * 都是已在工作区内解析过的绝对路径。
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { workspaceKey } from "../../session/workspace-key";

const CURRENT_VERSION = 1;

/** 回收站中的一条记录。 */
export interface TrashEntry {
  id: string;
  /** 删除前的原始绝对路径,恢复时写回此处。 */
  originalPath: string;
  name: string;
  isDirectory: boolean;
  size: number;
  /** 删除时刻,ISO 8601。 */
  deletedAt: string;
}

interface TrashIndex {
  version: number;
  entries: TrashEntry[];
}

// 串行化同一进程内的 index 读改写,避免并发删除/恢复互相覆盖。
let queue: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  // 吞掉错误只是为了不毒化队列;真实结果仍通过 next 返回给调用方。
  queue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

function trashRoot(workspaceRoot: string): string {
  return path.join(
    homedir(),
    ".filework",
    "trash",
    workspaceKey(workspaceRoot),
  );
}

function indexPath(workspaceRoot: string): string {
  return path.join(trashRoot(workspaceRoot), "index.json");
}

async function readIndex(workspaceRoot: string): Promise<TrashIndex> {
  try {
    const raw = await fs.readFile(indexPath(workspaceRoot), "utf-8");
    const parsed = JSON.parse(raw) as TrashIndex;
    if (parsed.version !== CURRENT_VERSION || !Array.isArray(parsed.entries)) {
      return { version: CURRENT_VERSION, entries: [] };
    }
    return parsed;
  } catch {
    // 不存在或损坏 —— 视为空回收站。
    return { version: CURRENT_VERSION, entries: [] };
  }
}

async function writeIndex(
  workspaceRoot: string,
  index: TrashIndex,
): Promise<void> {
  await fs.mkdir(trashRoot(workspaceRoot), { recursive: true });
  await fs.writeFile(
    indexPath(workspaceRoot),
    JSON.stringify(index, null, 2),
    "utf-8",
  );
}

/**
 * 移动 `src` 到 `dest`。优先用 rename(同盘原子);跨盘(EXDEV)回退为
 * 递归复制 + 删除源。
 */
async function move(src: string, dest: string): Promise<void> {
  try {
    await fs.rename(src, dest);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    await fs.cp(src, dest, { recursive: true });
    await fs.rm(src, { recursive: true, force: true });
  }
}

/**
 * 把 `absPath` 软删除到工作区回收站,返回记录。`absPath` 必须已在工作区内
 * 解析过。
 */
export function moveToTrash(
  workspaceRoot: string,
  absPath: string,
): Promise<TrashEntry> {
  return serialize(async () => {
    const stat = await fs.stat(absPath);
    const id = randomUUID();
    const name = path.basename(absPath);
    const stored = path.join(trashRoot(workspaceRoot), "files", id, name);

    await fs.mkdir(path.dirname(stored), { recursive: true });
    await move(absPath, stored);

    const entry: TrashEntry = {
      id,
      originalPath: absPath,
      name,
      isDirectory: stat.isDirectory(),
      size: stat.size,
      deletedAt: new Date().toISOString(),
    };

    const index = await readIndex(workspaceRoot);
    index.entries.push(entry);
    await writeIndex(workspaceRoot, index);

    return entry;
  });
}

/** 列出工作区回收站中的记录,按删除时间倒序(最近的在前)。 */
export function listTrash(workspaceRoot: string): Promise<TrashEntry[]> {
  return serialize(async () => {
    const index = await readIndex(workspaceRoot);
    return [...index.entries].sort((a, b) =>
      b.deletedAt.localeCompare(a.deletedAt),
    );
  });
}

/**
 * 把回收站记录 `id` 恢复回其原始路径。若原始路径已存在则拒绝(避免覆盖),
 * 由调用方决定先处理冲突。
 */
export function restoreFromTrash(
  workspaceRoot: string,
  id: string,
): Promise<{ restoredTo: string }> {
  return serialize(async () => {
    const index = await readIndex(workspaceRoot);
    const entry = index.entries.find((e) => e.id === id);
    if (!entry) {
      throw new Error(`回收站中找不到 id 为 "${id}" 的记录`);
    }

    const exists = await fs
      .access(entry.originalPath)
      .then(() => true)
      .catch(() => false);
    if (exists) {
      throw new Error(
        `原始路径已存在,拒绝覆盖:${entry.originalPath}。请先移走或删除该路径再恢复。`,
      );
    }

    const stored = path.join(
      trashRoot(workspaceRoot),
      "files",
      entry.id,
      entry.name,
    );
    await fs.mkdir(path.dirname(entry.originalPath), { recursive: true });
    await move(stored, entry.originalPath);
    // 清掉该记录的存储目录壳。
    await fs.rm(path.join(trashRoot(workspaceRoot), "files", entry.id), {
      recursive: true,
      force: true,
    });

    index.entries = index.entries.filter((e) => e.id !== id);
    await writeIndex(workspaceRoot, index);

    return { restoredTo: entry.originalPath };
  });
}

/**
 * 永久删除回收站内容。传 `id` 删除单条;省略则清空整个工作区回收站。
 * 返回被永久删除的记录数。
 */
export function emptyTrash(
  workspaceRoot: string,
  id?: string,
): Promise<{ removed: number }> {
  return serialize(async () => {
    const index = await readIndex(workspaceRoot);
    const targets = id
      ? index.entries.filter((e) => e.id === id)
      : index.entries;

    for (const entry of targets) {
      await fs.rm(path.join(trashRoot(workspaceRoot), "files", entry.id), {
        recursive: true,
        force: true,
      });
    }

    const removedIds = new Set(targets.map((e) => e.id));
    index.entries = index.entries.filter((e) => !removedIds.has(e.id));
    await writeIndex(workspaceRoot, index);

    return { removed: targets.length };
  });
}
