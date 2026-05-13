import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  checkoutBranchTo,
  cleanupLegacyAtRefCache,
  DirtyTreeError,
  withCloneLock,
} from "../clone-cache";

/**
 * Fake `spawn` matching the signature `clone-cache.ts:runGit` expects.
 * Each call's args are recorded; per-call exit codes and stdout/stderr
 * can be programmed via `responses` keyed by the first arg (the git
 * subcommand). Default is exit 0 with empty output.
 */
const buildFakeSpawn = (
  responses: Record<
    string,
    | { exitCode?: number; stdout?: string; stderr?: string }
    | Array<{ exitCode?: number; stdout?: string; stderr?: string }>
  > = {},
) => {
  const calls: Array<{ args: string[]; cwd?: string }> = [];
  const cursor: Record<string, number> = {};
  const fake = vi.fn(
    (_cmd: string, args: string[], opts?: { cwd?: string }) => {
      calls.push({ args, cwd: opts?.cwd });
      const key = args[0];
      const entry = responses[key];
      let pick: {
        exitCode?: number;
        stdout?: string;
        stderr?: string;
      } = {};
      if (Array.isArray(entry)) {
        const i = cursor[key] ?? 0;
        pick = entry[Math.min(i, entry.length - 1)] ?? {};
        cursor[key] = i + 1;
      } else if (entry) {
        pick = entry;
      }
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

// ---------------------------------------------------------------------------
// withCloneLock
// ---------------------------------------------------------------------------

describe("withCloneLock", () => {
  it("serializes operations on the same directory", async () => {
    const events: string[] = [];
    const dir = "/tmp/repo-A";
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

    const p1 = withCloneLock(dir, async () => {
      events.push("A-start");
      await wait(20);
      events.push("A-end");
    });
    const p2 = withCloneLock(dir, async () => {
      events.push("B-start");
      await wait(5);
      events.push("B-end");
    });

    await Promise.all([p1, p2]);
    expect(events).toEqual(["A-start", "A-end", "B-start", "B-end"]);
  });

  it("allows different directories to run in parallel", async () => {
    const events: string[] = [];
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

    const p1 = withCloneLock("/tmp/repo-A", async () => {
      events.push("A-start");
      await wait(20);
      events.push("A-end");
    });
    const p2 = withCloneLock("/tmp/repo-B", async () => {
      events.push("B-start");
      await wait(5);
      events.push("B-end");
    });

    await Promise.all([p1, p2]);
    // B has shorter wait — finishes before A despite the same start tick.
    expect(events).toEqual(["A-start", "B-start", "B-end", "A-end"]);
  });

  it("releases the lock when the operation throws", async () => {
    const dir = "/tmp/repo-throw";
    await expect(
      withCloneLock(dir, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    // The next caller must still acquire — otherwise the queue deadlocks.
    const result = await withCloneLock(dir, async () => "ok");
    expect(result).toBe("ok");
  });

  it("returns the operation's value", async () => {
    const out = await withCloneLock("/tmp/repo-value", async () => 42);
    expect(out).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// DirtyTreeError
// ---------------------------------------------------------------------------

describe("DirtyTreeError", () => {
  it("carries cloneDir + targetBranch and renders a helpful message", () => {
    const err = new DirtyTreeError("/cache/owner/repo", "feature/x");
    expect(err.name).toBe("DirtyTreeError");
    expect(err.cloneDir).toBe("/cache/owner/repo");
    expect(err.targetBranch).toBe("feature/x");
    expect(err.message).toContain("/cache/owner/repo");
    expect(err.message).toContain("feature/x");
    expect(err.message.toLowerCase()).toContain("uncommitted");
  });
});

// ---------------------------------------------------------------------------
// checkoutBranchTo
// ---------------------------------------------------------------------------

describe("checkoutBranchTo", () => {
  const cwd = "/cache/owner/repo";

  it("is a no-op when already on the target branch", async () => {
    const { fake, calls } = buildFakeSpawn({
      "rev-parse": { stdout: "feature/x\n" },
    });
    await checkoutBranchTo(cwd, "feature/x", fake as never);
    const subs = calls.map((c) => c.args[0]);
    expect(subs).toEqual(["rev-parse"]);
  });

  it("throws DirtyTreeError when the working tree is dirty", async () => {
    const { fake } = buildFakeSpawn({
      "rev-parse": { stdout: "main\n" },
      status: { stdout: " M src/foo.ts\n" },
    });
    await expect(
      checkoutBranchTo(cwd, "feature/x", fake as never),
    ).rejects.toBeInstanceOf(DirtyTreeError);
  });

  it("checks out the existing local branch when it exists", async () => {
    const { fake, calls } = buildFakeSpawn({
      "rev-parse": [
        { stdout: "main\n" }, // HEAD
        { exitCode: 0 }, // refs/heads/feature/x exists
      ],
      status: { stdout: "" },
      checkout: { exitCode: 0 },
    });
    await checkoutBranchTo(cwd, "feature/x", fake as never);
    const checkoutCall = calls.find((c) => c.args[0] === "checkout");
    expect(checkoutCall?.args).toEqual(["checkout", "feature/x"]);
  });

  it("creates the local branch tracking origin/<branch> when missing", async () => {
    const { fake, calls } = buildFakeSpawn({
      "rev-parse": [
        { stdout: "main\n" }, // HEAD
        { exitCode: 1 }, // refs/heads/feature/x missing
      ],
      status: { stdout: "" },
      checkout: { exitCode: 0 },
    });
    await checkoutBranchTo(cwd, "feature/x", fake as never);
    const checkoutCall = calls.find((c) => c.args[0] === "checkout");
    expect(checkoutCall?.args).toEqual([
      "checkout",
      "-B",
      "feature/x",
      "origin/feature/x",
    ]);
  });

  it("surfaces git's stderr when checkout fails", async () => {
    const { fake } = buildFakeSpawn({
      "rev-parse": [{ stdout: "main\n" }, { exitCode: 0 }],
      status: { stdout: "" },
      checkout: { exitCode: 1, stderr: "error: pathspec did not match\n" },
    });
    await expect(
      checkoutBranchTo(cwd, "feature/x", fake as never),
    ).rejects.toThrow(/pathspec did not match/);
  });
});

// ---------------------------------------------------------------------------
// cleanupLegacyAtRefCache
// ---------------------------------------------------------------------------

describe("cleanupLegacyAtRefCache", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "fw-legacy-cache-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("removes <name>@<ref> directories that look like clones (have .git)", async () => {
    const legacy1 = path.join(root, "acme", "app@main");
    const legacy2 = path.join(root, "acme", "app@feature/v1");
    await mkdir(path.join(legacy1, ".git"), { recursive: true });
    await writeFile(path.join(legacy1, "README"), "x");
    await mkdir(path.join(legacy2, ".git"), { recursive: true });

    const { removed } = await cleanupLegacyAtRefCache([root]);
    expect(removed).toBe(2);

    await expect(rm(legacy1)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(rm(legacy2)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("leaves @-named directories without a .git (not our clones)", async () => {
    const userDir = path.join(root, "scoped@dir");
    await mkdir(userDir, { recursive: true });
    await writeFile(path.join(userDir, "notes.txt"), "user data");

    const { removed } = await cleanupLegacyAtRefCache([root]);
    expect(removed).toBe(0);

    // Still present — adding a file would throw if the directory were gone.
    await writeFile(path.join(userDir, "still-here"), "x");
  });

  it("removes legacy clones whose ref contained slashes (nested @dir/.git)", async () => {
    // Real-world layout from the user's cache:
    //   gitlab.quguazhan.com/web/admin@feature/v1.3/.git
    // The `app@feature` directory has no direct .git — the .git lives
    // one level deeper inside `v1.3/`. Sweep must still recognize the
    // whole `app@feature` subtree as a legacy clone and remove it.
    const slashRef = path.join(root, "web", "admin@feature", "v1.3");
    await mkdir(path.join(slashRef, ".git"), { recursive: true });

    const { removed } = await cleanupLegacyAtRefCache([root]);
    expect(removed).toBe(1);

    // The whole `admin@feature` tree (including `v1.3/.git`) is gone.
    await expect(rm(slashRef)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      rm(path.join(root, "web", "admin@feature")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recurses through non-@ parent directories", async () => {
    // Mimics the GitLab layout: <root>/<host>/<namespace>/<project>@<ref>.
    const deep = path.join(
      root,
      "gitlab.example.com",
      "acme",
      "sub",
      "app@main",
    );
    await mkdir(path.join(deep, ".git"), { recursive: true });

    const { removed } = await cleanupLegacyAtRefCache([root]);
    expect(removed).toBe(1);
    await expect(rm(deep)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("is a no-op when a root is missing", async () => {
    const missing = path.join(root, "does-not-exist");
    const { removed } = await cleanupLegacyAtRefCache([missing]);
    expect(removed).toBe(0);
  });

  it("is idempotent — second run removes nothing", async () => {
    const legacy = path.join(root, "owner", "repo@main");
    await mkdir(path.join(legacy, ".git"), { recursive: true });

    const first = await cleanupLegacyAtRefCache([root]);
    expect(first.removed).toBe(1);
    const second = await cleanupLegacyAtRefCache([root]);
    expect(second.removed).toBe(0);
  });
});
