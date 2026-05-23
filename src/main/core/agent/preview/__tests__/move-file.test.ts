import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LocalWorkspace } from "../../../workspace/local-workspace";
import { computeMoveFilePreview } from "../move-file";

describe("computeMoveFilePreview", () => {
  let root: string;
  let ws: LocalWorkspace;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "fw-preview-move-"));
    ws = new LocalWorkspace(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("reports the structural shape of a normal file move", async () => {
    await ws.fs.writeFile("src.txt", "hello");
    const preview = await computeMoveFilePreview(
      { source: "src.txt", destination: "moved.txt" },
      ws,
    );
    expect(preview.sourceExists).toBe(true);
    expect(preview.sourceType).toBe("file");
    expect(preview.destinationExists).toBe(false);
  });

  it("flags destinationExists when the destination is occupied", async () => {
    await ws.fs.writeFile("a.txt", "1");
    await ws.fs.writeFile("b.txt", "2");
    const preview = await computeMoveFilePreview(
      { source: "a.txt", destination: "b.txt" },
      ws,
    );
    expect(preview.destinationExists).toBe(true);
  });

  it("reports missing source", async () => {
    const preview = await computeMoveFilePreview(
      { source: "nowhere.txt", destination: "somewhere.txt" },
      ws,
    );
    expect(preview.sourceExists).toBe(false);
    expect(preview.sourceType).toBe("unknown");
  });

  it("detects directory sources", async () => {
    await ws.fs.mkdir("subdir", { recursive: true });
    const preview = await computeMoveFilePreview(
      { source: "subdir", destination: "renamed" },
      ws,
    );
    expect(preview.sourceType).toBe("dir");
  });
});
