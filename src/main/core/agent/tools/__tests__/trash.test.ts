import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { emptyTrash, listTrash, moveToTrash, restoreFromTrash } from "../trash";

const originalHome = process.env.HOME;

let workspaceRoot: string;

beforeEach(async () => {
  // 回收站位于 ~/.filework/trash;用临时 HOME 隔离每个用例。
  process.env.HOME = await mkdtemp(join(tmpdir(), "filework-home-"));
  workspaceRoot = await mkdtemp(join(tmpdir(), "filework-ws-"));
});

afterEach(() => {
  process.env.HOME = originalHome;
});

const exists = (p: string): Promise<boolean> =>
  stat(p)
    .then(() => true)
    .catch(() => false);

describe("trash", () => {
  it("soft-deletes a file then restores it with content intact", async () => {
    const file = join(workspaceRoot, "note.txt");
    await writeFile(file, "hello", "utf-8");

    const entry = await moveToTrash(workspaceRoot, file);
    expect(entry.originalPath).toBe(file);
    expect(entry.isDirectory).toBe(false);
    expect(await exists(file)).toBe(false);

    const listed = await listTrash(workspaceRoot);
    expect(listed).toHaveLength(1);
    expect(listed[0].id).toBe(entry.id);

    const { restoredTo } = await restoreFromTrash(workspaceRoot, entry.id);
    expect(restoredTo).toBe(file);
    expect(await readFile(file, "utf-8")).toBe("hello");
    expect(await listTrash(workspaceRoot)).toHaveLength(0);
  });

  it("refuses to restore when the original path is occupied", async () => {
    const file = join(workspaceRoot, "dup.txt");
    await writeFile(file, "v1", "utf-8");
    const entry = await moveToTrash(workspaceRoot, file);

    // 同名文件重新出现 —— 恢复必须拒绝以免覆盖。
    await writeFile(file, "v2", "utf-8");
    await expect(restoreFromTrash(workspaceRoot, entry.id)).rejects.toThrow(
      /已存在/,
    );
    // 拒绝后记录仍在回收站,可后续处理。
    expect(await listTrash(workspaceRoot)).toHaveLength(1);
    expect(await readFile(file, "utf-8")).toBe("v2");
  });

  it("permanently erases via emptyTrash", async () => {
    await writeFile(join(workspaceRoot, "a.txt"), "a", "utf-8");
    await writeFile(join(workspaceRoot, "b.txt"), "b", "utf-8");
    await moveToTrash(workspaceRoot, join(workspaceRoot, "a.txt"));
    const b = await moveToTrash(workspaceRoot, join(workspaceRoot, "b.txt"));

    const one = await emptyTrash(workspaceRoot, b.id);
    expect(one.removed).toBe(1);
    expect(await listTrash(workspaceRoot)).toHaveLength(1);

    const all = await emptyTrash(workspaceRoot);
    expect(all.removed).toBe(1);
    expect(await listTrash(workspaceRoot)).toHaveLength(0);
  });

  it("soft-deletes a directory recursively and restores it", async () => {
    const dir = join(workspaceRoot, "folder");
    await mkdir(dir);
    await writeFile(join(dir, "inner.txt"), "deep", "utf-8");

    const entry = await moveToTrash(workspaceRoot, dir);
    expect(entry.isDirectory).toBe(true);
    expect(await exists(dir)).toBe(false);

    await restoreFromTrash(workspaceRoot, entry.id);
    expect(await readFile(join(dir, "inner.txt"), "utf-8")).toBe("deep");
  });
});
