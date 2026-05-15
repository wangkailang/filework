import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { listLocalBranches, probeLocalGit } from "../local-git";

const buildFakeSpawn = (
  responses: Record<
    string,
    { exitCode?: number; stdout?: string; stderr?: string }
  > = {},
) => {
  const calls: Array<{ args: string[]; cwd?: string }> = [];
  const fake = vi.fn(
    (_cmd: string, args: string[], opts?: { cwd?: string }) => {
      calls.push({ args, cwd: opts?.cwd });
      const pick = responses[args[0]] ?? {};
      const proc = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
      };
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      setImmediate(() => {
        if (pick.stdout) proc.stdout.emit("data", Buffer.from(pick.stdout));
        if (pick.stderr) proc.stderr.emit("data", Buffer.from(pick.stderr));
        proc.emit("close", pick.exitCode ?? 0);
      });
      // biome-ignore lint/suspicious/noExplicitAny: test stub shape
      return proc as any;
    },
  );
  return { fake, calls };
};

describe("probeLocalGit", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "local-git-test-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("returns isGitRepo:false for a non-git directory", async () => {
    const { fake, calls } = buildFakeSpawn();
    const result = await probeLocalGit(
      tmp,
      fake as unknown as typeof import("node:child_process").spawn,
    );
    expect(result).toEqual({ isGitRepo: false, currentBranch: null });
    expect(calls).toHaveLength(0);
  });

  it("returns the branch name for a git repo on a named branch", async () => {
    await mkdir(path.join(tmp, ".git"));
    const { fake } = buildFakeSpawn({
      "rev-parse": { exitCode: 0, stdout: "feature/x\n" },
    });
    const result = await probeLocalGit(
      tmp,
      fake as unknown as typeof import("node:child_process").spawn,
    );
    expect(result).toEqual({ isGitRepo: true, currentBranch: "feature/x" });
  });

  it("returns currentBranch:null for detached HEAD", async () => {
    await mkdir(path.join(tmp, ".git"));
    const { fake } = buildFakeSpawn({
      "rev-parse": { exitCode: 0, stdout: "HEAD\n" },
    });
    const result = await probeLocalGit(
      tmp,
      fake as unknown as typeof import("node:child_process").spawn,
    );
    expect(result).toEqual({ isGitRepo: true, currentBranch: null });
  });

  it("returns currentBranch:null when rev-parse fails", async () => {
    await mkdir(path.join(tmp, ".git"));
    const { fake } = buildFakeSpawn({
      "rev-parse": { exitCode: 128, stderr: "fatal: not a git repo" },
    });
    const result = await probeLocalGit(
      tmp,
      fake as unknown as typeof import("node:child_process").spawn,
    );
    expect(result).toEqual({ isGitRepo: true, currentBranch: null });
  });
});

describe("listLocalBranches", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "local-git-test-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("parses for-each-ref output into BranchSummary entries", async () => {
    const { fake, calls } = buildFakeSpawn({
      "for-each-ref": { exitCode: 0, stdout: "main\nfeature/x\nfix/y\n" },
    });
    const branches = await listLocalBranches(
      tmp,
      fake as unknown as typeof import("node:child_process").spawn,
    );
    expect(branches).toEqual([
      { name: "main", protected: false },
      { name: "feature/x", protected: false },
      { name: "fix/y", protected: false },
    ]);
    expect(calls[0].args).toEqual([
      "for-each-ref",
      "--format=%(refname:short)",
      "refs/heads/",
    ]);
  });

  it("returns empty array when no local branches exist", async () => {
    const { fake } = buildFakeSpawn({
      "for-each-ref": { exitCode: 0, stdout: "" },
    });
    const branches = await listLocalBranches(
      tmp,
      fake as unknown as typeof import("node:child_process").spawn,
    );
    expect(branches).toEqual([]);
  });

  it("throws when git for-each-ref fails", async () => {
    const { fake } = buildFakeSpawn({
      "for-each-ref": { exitCode: 128, stderr: "fatal: bad path" },
    });
    await expect(
      listLocalBranches(
        tmp,
        fake as unknown as typeof import("node:child_process").spawn,
      ),
    ).rejects.toThrow(/for-each-ref failed/);
  });
});
