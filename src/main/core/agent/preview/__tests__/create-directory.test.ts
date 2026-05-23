import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LocalWorkspace } from "../../../workspace/local-workspace";
import { computeCreateDirectoryPreview } from "../create-directory";

describe("computeCreateDirectoryPreview", () => {
  let root: string;
  let ws: LocalWorkspace;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "fw-preview-mkdir-"));
    ws = new LocalWorkspace(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("reports a fresh nested directory with parentExists=false", async () => {
    const preview = await computeCreateDirectoryPreview(
      { path: "nested/leaf" },
      ws,
    );
    expect(preview.alreadyExists).toBe(false);
    expect(preview.parentExists).toBe(false);
  });

  it("reports parentExists when the parent already exists", async () => {
    await ws.fs.mkdir("parent", { recursive: true });
    const preview = await computeCreateDirectoryPreview(
      { path: "parent/child" },
      ws,
    );
    expect(preview.parentExists).toBe(true);
    expect(preview.alreadyExists).toBe(false);
  });

  it("flags alreadyExists when the directory is already present", async () => {
    await ws.fs.mkdir("here", { recursive: true });
    const preview = await computeCreateDirectoryPreview({ path: "here" }, ws);
    expect(preview.alreadyExists).toBe(true);
  });
});
