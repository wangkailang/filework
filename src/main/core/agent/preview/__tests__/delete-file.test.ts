import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LocalWorkspace } from "../../../workspace/local-workspace";
import { computeDeleteFilePreview } from "../delete-file";

describe("computeDeleteFilePreview", () => {
  let root: string;
  let ws: LocalWorkspace;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "fw-preview-del-"));
    ws = new LocalWorkspace(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("returns exists=false when the path does not exist", async () => {
    const preview = await computeDeleteFilePreview({ path: "missing.txt" }, ws);
    expect(preview.exists).toBe(false);
    expect(preview.type).toBe("unknown");
    expect(preview.sizeBytes).toBeUndefined();
  });

  it("reports text file size and head preview", async () => {
    const body = "line-1\nline-2\nline-3\n";
    await ws.fs.writeFile("note.txt", body);
    const preview = await computeDeleteFilePreview({ path: "note.txt" }, ws);
    expect(preview.exists).toBe(true);
    expect(preview.type).toBe("file");
    expect(preview.sizeBytes).toBe(Buffer.byteLength(body, "utf8"));
    expect(preview.headPreview).toEqual(["line-1", "line-2", "line-3", ""]);
  });

  it("omits headPreview for binary files", async () => {
    const bin = Buffer.from([0x01, 0x00, 0x02, 0x03]);
    await ws.fs.writeFile("blob.bin", bin);
    const preview = await computeDeleteFilePreview({ path: "blob.bin" }, ws);
    expect(preview.type).toBe("file");
    expect(preview.headPreview).toBeUndefined();
  });

  it("counts directory children and aggregates size", async () => {
    await ws.fs.mkdir("dir/sub", { recursive: true });
    await ws.fs.writeFile("dir/a.txt", "aa");
    await ws.fs.writeFile("dir/sub/b.txt", "bbbb");
    const preview = await computeDeleteFilePreview({ path: "dir" }, ws);
    expect(preview.type).toBe("dir");
    expect(preview.childCount).toBeGreaterThanOrEqual(2);
    expect(preview.sizeBytes).toBeGreaterThanOrEqual(2 + 4);
  });
});
