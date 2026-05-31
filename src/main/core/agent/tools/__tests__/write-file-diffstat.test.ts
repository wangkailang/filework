import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LocalWorkspace } from "../../../workspace/local-workspace";
import type { ToolContext, ToolDefinition } from "../../tool-registry";
import { buildFileTools } from "../index";

function writeTool(): ToolDefinition {
  const t = buildFileTools().find((x) => x.name === "writeFile");
  if (!t) throw new Error("writeFile tool not found");
  return t;
}

describe("writeFile result.diffStat", () => {
  let root: string;
  let ws: LocalWorkspace;
  let ctx: ToolContext;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "fw-writestat-"));
    ws = new LocalWorkspace(root);
    ctx = {
      workspace: ws,
      signal: new AbortController().signal,
      toolCallId: "call-1",
    };
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("reports a new file as isNew with added line count", async () => {
    const result = (await writeTool().execute(
      { path: "new.txt", content: "alpha\nbeta\n" },
      ctx,
    )) as Record<string, unknown>;
    expect(result.success).toBe(true);
    expect(result.diffStat).toMatchObject({
      added: 2,
      removed: 0,
      isNew: true,
      isBinary: false,
      truncated: false,
    });
  });

  it("reports +/- against the pre-image on overwrite", async () => {
    await ws.fs.writeFile("README.md", "title\nbody\n");
    const result = (await writeTool().execute(
      { path: "README.md", content: "title\nbody updated\nextra\n" },
      ctx,
    )) as Record<string, unknown>;
    const diffStat = result.diffStat as Record<string, unknown>;
    expect(diffStat.isNew).toBe(false);
    expect(diffStat.added).toBe(2);
    expect(diffStat.removed).toBe(1);
  });
});
