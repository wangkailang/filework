import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LocalWorkspace } from "../../../workspace/local-workspace";
import { computeRunCommandPreview } from "../run-command";

describe("computeRunCommandPreview", () => {
  let root: string;
  let ws: LocalWorkspace;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "fw-preview-run-"));
    ws = new LocalWorkspace(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("treats no cwd as ok", async () => {
    const preview = await computeRunCommandPreview({ command: "echo hi" }, ws);
    expect(preview.cwdExists).toBe(true);
    expect(preview.cwd).toBeUndefined();
    expect(preview.command).toBe("echo hi");
  });

  it("reports cwdExists=true when the cwd is inside the workspace", async () => {
    await ws.fs.mkdir("here", { recursive: true });
    const preview = await computeRunCommandPreview(
      { command: "ls", cwd: "here" },
      ws,
    );
    expect(preview.cwdExists).toBe(true);
  });

  it("reports cwdExists=false when the cwd does not exist", async () => {
    const preview = await computeRunCommandPreview(
      { command: "ls", cwd: "nowhere" },
      ws,
    );
    expect(preview.cwdExists).toBe(false);
    expect(preview.cwd).toBe("nowhere");
  });

  it("reports cwdExists=false for cwd outside the workspace", async () => {
    const outside = path.join(tmpdir(), "outside-fw-test");
    const preview = await computeRunCommandPreview(
      { command: "ls", cwd: outside },
      ws,
    );
    expect(preview.cwdExists).toBe(false);
  });
});
