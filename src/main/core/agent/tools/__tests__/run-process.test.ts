import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LocalWorkspace } from "../../../workspace/local-workspace";
import type { ToolContext, ToolDefinition } from "../../tool-registry";
import { buildFileTools } from "../index";

function toolByName(name: string): ToolDefinition {
  const tool = buildFileTools().find((x) => x.name === name);
  if (!tool) throw new Error(`${name} tool not found`);
  return tool;
}

describe("run process tools", () => {
  let root: string;
  let ws: LocalWorkspace;
  let ctx: ToolContext;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "fw-run-process-"));
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

  it("runs an executable with argv without shell-parsing special characters", async () => {
    const specialDir = "一周99(1)";
    const specialArg = "boggle_solver(1).py";
    await ws.fs.mkdir(specialDir, { recursive: true });

    const result = (await toolByName("runProcess").execute(
      {
        executable: process.execPath,
        args: [
          "-e",
          "console.log(process.cwd()); console.log(process.argv[1])",
          specialArg,
        ],
        cwd: specialDir,
      },
      ctx,
    )) as Record<string, unknown>;

    expect(result.success).toBe(true);
    expect(result.stdout).toContain(specialDir);
    expect(result.stdout).toContain(specialArg);
  });

  it("adds a quoting hint when a shell command fails on an unquoted parenthesis", async () => {
    const result = (await toolByName("runCommand").execute(
      { command: "echo /tmp/boggle_solver(1).py" },
      ctx,
    )) as Record<string, unknown>;

    expect(result.success).toBe(false);
    expect(result.hint).toEqual(expect.stringContaining("runProcess"));
  });

  it("adds a quoting hint for POSIX sh unexpected-token syntax errors", async () => {
    const result = (await toolByName("runCommand").execute(
      {
        command:
          "printf '%s\\n' 'sh: 1: Syntax error: \"(\" unexpected' >&2; exit 2",
      },
      ctx,
    )) as Record<string, unknown>;

    expect(result.success).toBe(false);
    expect(result.hint).toEqual(expect.stringContaining("runProcess"));
  });

  it("adds a host-network hint for GitHub release asset TLS failures", async () => {
    const result = (await toolByName("runCommand").execute(
      {
        command:
          "printf '%s\\n' 'curl: (35) LibreSSL SSL_connect: SSL_ERROR_SYSCALL in connection to release-assets.githubusercontent.com:443' >&2; exit 2",
        escalatePermissions: true,
        reason: "brew install needs network",
      },
      ctx,
    )) as Record<string, unknown>;

    expect(result.success).toBe(false);
    expect(result.hint).toEqual(expect.stringContaining("host network"));
    expect(result.hint).toEqual(expect.stringContaining("proxy"));
    expect(result.hint).not.toEqual(expect.stringContaining("sandbox"));
    expect(result.hint).not.toEqual(
      expect.stringContaining("rerun the same command locally"),
    );
  });

  it("adds a sandbox file-write hint when a command writes outside the workspace", async () => {
    const tool = buildFileTools({
      sandbox: { mode: "workspace-write", allowNetwork: false },
    }).find((x) => x.name === "runCommand");
    if (!tool) throw new Error("runCommand tool not found");

    const result = (await tool.execute(
      {
        command:
          "printf '%s\\n' 'error: could not lock config file /Users/kailang/.gitconfig: Operation not permitted' >&2; exit 255",
      },
      ctx,
    )) as Record<string, unknown>;

    expect(result.success).toBe(false);
    expect(result.hint).toEqual(expect.stringContaining("file-write policy"));
    expect(result.hint).toEqual(
      expect.stringContaining("outside the workspace"),
    );
    expect(result.hint).toEqual(
      expect.stringContaining("escalatePermissions:true"),
    );
    expect(result.displayHint).toEqual(
      expect.stringContaining("Command sandbox blocked"),
    );
  });

  it("does not add a network recovery hint to successful commands", async () => {
    const result = (await toolByName("runCommand").execute(
      {
        command:
          "printf '%s\\n' 'release-assets.githubusercontent.com is reachable'",
      },
      ctx,
    )) as Record<string, unknown>;

    expect(result.success).toBe(true);
    expect(result.hint).toBeUndefined();
  });
});
