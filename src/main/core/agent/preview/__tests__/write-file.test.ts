import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LocalWorkspace } from "../../../workspace/local-workspace";
import { computeWriteFilePreview } from "../write-file";

describe("computeWriteFilePreview", () => {
  let root: string;
  let ws: LocalWorkspace;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "fw-preview-write-"));
    ws = new LocalWorkspace(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("treats a missing file as a creation with full content as one added hunk", async () => {
    const preview = await computeWriteFilePreview(
      { path: "new.txt", content: "alpha\nbeta\n" },
      ws,
    );
    expect(preview.action).toBe("create");
    expect(preview.oldExists).toBe(false);
    expect(preview.oldLines).toBe(0);
    expect(preview.newLines).toBe(2);
    expect(preview.added).toBe(2);
    expect(preview.removed).toBe(0);
    expect(preview.hunks).toHaveLength(1);
    expect(preview.hunks[0]).toMatchObject({
      kind: "added",
      value: "alpha\nbeta\n",
      lineCount: 2,
    });
    expect(preview.oldHash).toBeUndefined();
  });

  it("counts +/- lines and emits matching hunks on overwrite", async () => {
    await ws.fs.writeFile("README.md", "title\nbody\n");
    const preview = await computeWriteFilePreview(
      { path: "README.md", content: "title\nbody updated\nextra\n" },
      ws,
    );
    expect(preview.action).toBe("overwrite");
    expect(preview.oldExists).toBe(true);
    expect(preview.oldLines).toBe(2);
    expect(preview.newLines).toBe(3);
    expect(preview.added).toBe(2);
    expect(preview.removed).toBe(1);
    const kinds = preview.hunks.map((h) => h.kind);
    expect(kinds).toContain("added");
    expect(kinds).toContain("removed");
    const removedHunk = preview.hunks.find((h) => h.kind === "removed");
    expect(removedHunk?.oldStart).toBe(2);
    expect(removedHunk?.newStart).toBeUndefined();
    const addedHunk = preview.hunks.find((h) => h.kind === "added");
    expect(addedHunk?.oldStart).toBeUndefined();
    expect(addedHunk?.newStart).toBe(2);
    expect(preview.oldHash).toMatch(/^[0-9a-f]{40}$/);
  });

  it("reports no-op when content matches exactly", async () => {
    await ws.fs.writeFile("same.txt", "x\n");
    const preview = await computeWriteFilePreview(
      { path: "same.txt", content: "x\n" },
      ws,
    );
    expect(preview.added).toBe(0);
    expect(preview.removed).toBe(0);
    expect(preview.hunks).toEqual([]);
    expect(preview.oldHash).toMatch(/^[0-9a-f]{40}$/);
  });

  it("marks binary preview when NUL byte appears in pre-image", async () => {
    const binary = Buffer.from([0x48, 0x00, 0x49, 0x4a]);
    await ws.fs.writeFile("blob.bin", binary);
    const preview = await computeWriteFilePreview(
      { path: "blob.bin", content: "plain\n" },
      ws,
    );
    expect(preview.isBinary).toBe(true);
    expect(preview.hunks).toEqual([]);
    expect(preview.action).toBe("overwrite");
  });

  it("truncates oversized pre-image without computing diff", async () => {
    const big = "x".repeat(2 * 1024 * 1024);
    await ws.fs.writeFile("big.txt", big);
    const preview = await computeWriteFilePreview(
      { path: "big.txt", content: "small\n" },
      ws,
    );
    expect(preview.truncated).toBe("oldTooLarge");
    expect(preview.hunks).toEqual([]);
    expect(preview.added).toBe(0);
    expect(preview.removed).toBe(0);
  });

  it("truncates oversized post-image without computing diff", async () => {
    await ws.fs.writeFile("seed.txt", "tiny\n");
    const huge = "y".repeat(2 * 1024 * 1024);
    const preview = await computeWriteFilePreview(
      { path: "seed.txt", content: huge },
      ws,
    );
    expect(preview.truncated).toBe("newTooLarge");
    expect(preview.hunks).toEqual([]);
  });

  it("accepts absolute paths inside the workspace", async () => {
    const abs = path.join(root, "abs.txt");
    const preview = await computeWriteFilePreview(
      { path: abs, content: "hello\n" },
      ws,
    );
    expect(preview.action).toBe("create");
    expect(preview.path).toBe(abs);
    expect(preview.added).toBe(1);
  });

  it("rejects paths outside the workspace via toRelative", async () => {
    const outside = path.join(tmpdir(), "definitely-outside-fw-test.txt");
    await expect(
      computeWriteFilePreview({ path: outside, content: "x" }, ws),
    ).rejects.toThrow();
  });
});
