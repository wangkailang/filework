import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __test__,
  ensureClone,
  type GitHubRef,
  GitHubWorkspace,
} from "../github-workspace";

/**
 * Build a fake `spawn` that records every invocation and replays canned
 * exit codes per `git` subcommand. Lets us test ensureClone +
 * GitHubWorkspace without touching the network.
 */
const buildFakeSpawn = () => {
  const calls: Array<{ args: string[]; cwd?: string }> = [];
  const fake = vi.fn(
    (
      _cmd: string,
      args: string[],
      opts?: { cwd?: string; env?: NodeJS.ProcessEnv },
    ) => {
      calls.push({ args, cwd: opts?.cwd });
      const proc = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
      };
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      // Materialize the .git dir so cloneExists() returns true after the
      // call returns (matches what real git would do).
      if (args[0] === "clone") {
        const cloneDir = args[args.length - 1];
        mkdir(path.join(cloneDir, ".git"), { recursive: true }).then(() =>
          setImmediate(() => proc.emit("close", 0)),
        );
      } else {
        setImmediate(() => proc.emit("close", 0));
      }
      return proc;
    },
  );
  return { fake, calls };
};

const fakeRef: GitHubRef = {
  kind: "github",
  owner: "acme",
  repo: "app",
  ref: "main",
  credentialId: "cred-1",
};

describe("ensureClone", () => {
  let cacheDir: string;

  beforeEach(async () => {
    cacheDir = await mkdtemp(path.join(tmpdir(), "fw-clone-cache-"));
  });

  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
  });

  it("runs git clone with --depth 1 --branch <ref> and the authed URL", async () => {
    const { fake, calls } = buildFakeSpawn();
    const expectedDir = path.join(cacheDir, "acme", "app@main");

    const result = await ensureClone(fakeRef, {
      resolveToken: async () => "ghp_TESTTOKEN",
      cacheDir,
      // biome-ignore lint/suspicious/noExplicitAny: test stub for spawn
      spawnFn: fake as any,
    });

    expect(result).toBe(expectedDir);
    const cloneCall = calls.find((c) => c.args[0] === "clone");
    expect(cloneCall).toBeDefined();
    expect(cloneCall?.args).toContain("--depth");
    expect(cloneCall?.args).toContain("1");
    expect(cloneCall?.args).toContain("--branch");
    expect(cloneCall?.args).toContain("main");
    const remoteArg = cloneCall?.args[cloneCall.args.length - 2] ?? "";
    expect(remoteArg).toMatch(/^https:\/\/x-access-token:/);
    expect(remoteArg).toContain("@github.com/acme/app.git");

    const stampStat = await stat(path.join(expectedDir, ".last-fetch"));
    expect(stampStat.isFile()).toBe(true);
  });

  it("skips git when the existing clone is fresh", async () => {
    const cloneDir = path.join(cacheDir, "acme", "app@main");
    await mkdir(path.join(cloneDir, ".git"), { recursive: true });
    await writeFile(
      path.join(cloneDir, ".last-fetch"),
      new Date().toISOString(),
      "utf8",
    );

    const { fake, calls } = buildFakeSpawn();
    const result = await ensureClone(fakeRef, {
      resolveToken: async () => "ghp_TESTTOKEN",
      cacheDir,
      freshnessTtlMs: 60_000,
      // biome-ignore lint/suspicious/noExplicitAny: test stub for spawn
      spawnFn: fake as any,
    });

    expect(result).toBe(cloneDir);
    expect(calls.length).toBe(0);
  });

  it("re-fetches when the clone is stale", async () => {
    const cloneDir = path.join(cacheDir, "acme", "app@main");
    await mkdir(path.join(cloneDir, ".git"), { recursive: true });
    await writeFile(
      path.join(cloneDir, ".last-fetch"),
      "2000-01-01T00:00:00.000Z",
      "utf8",
    );

    const { fake, calls } = buildFakeSpawn();
    await ensureClone(fakeRef, {
      resolveToken: async () => "ghp_TESTTOKEN",
      cacheDir,
      // TTL=0 → any non-zero age is stale; bypasses race with fast disks
      // where the freshly-written stamp might still be < 1ms old.
      freshnessTtlMs: 0,
      // biome-ignore lint/suspicious/noExplicitAny: test stub for spawn
      spawnFn: fake as any,
    });

    const subs = calls.map((c) => c.args[0]);
    expect(subs).toContain("remote");
    expect(subs).toContain("fetch");
    expect(subs).toContain("reset");
  });
});

describe("GitHubWorkspace.create", () => {
  let cacheDir: string;

  beforeEach(async () => {
    cacheDir = await mkdtemp(path.join(tmpdir(), "fw-clone-cache-"));
  });

  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
  });

  it("constructs a Workspace with id derived from the ref and root = clone dir", async () => {
    const cloneDir = path.join(cacheDir, "acme", "app@main");
    await mkdir(cloneDir, { recursive: true });
    await mkdir(path.join(cloneDir, ".git"), { recursive: true });
    await writeFile(
      path.join(cloneDir, ".last-fetch"),
      new Date().toISOString(),
      "utf8",
    );
    await writeFile(path.join(cloneDir, "README.md"), "# hello\n", "utf8");

    const { fake } = buildFakeSpawn();
    const ws = await GitHubWorkspace.create(fakeRef, {
      resolveToken: async () => "ghp_TESTTOKEN",
      cacheDir,
      freshnessTtlMs: 60_000,
      // biome-ignore lint/suspicious/noExplicitAny: test stub for spawn
      spawnFn: fake as any,
    });

    expect(ws.kind).toBe("github");
    expect(ws.id).toBe("github:acme/app@main");
    expect(ws.root).toBe(cloneDir);
    const readme = await ws.fs.readFile("README.md");
    expect(readme).toContain("hello");
  });

  it("blocks `git push`-style commands via exec", async () => {
    const cloneDir = path.join(cacheDir, "acme", "app@main");
    await mkdir(path.join(cloneDir, ".git"), { recursive: true });
    await writeFile(
      path.join(cloneDir, ".last-fetch"),
      new Date().toISOString(),
      "utf8",
    );

    const { fake } = buildFakeSpawn();
    const ws = await GitHubWorkspace.create(fakeRef, {
      resolveToken: async () => "ghp_TESTTOKEN",
      cacheDir,
      freshnessTtlMs: 60_000,
      // biome-ignore lint/suspicious/noExplicitAny: test stub for spawn
      spawnFn: fake as any,
    });

    const result = await ws.exec.run("git push origin main");
    expect(result.exitCode).toBe(126);
    expect(result.stderr).toContain("M6 PR 2");
  });
});

describe("looksLikeGitWrite", () => {
  const { looksLikeGitWrite } = __test__;

  it("flags push / commit / reset", () => {
    expect(looksLikeGitWrite("git push")).toBe(true);
    expect(looksLikeGitWrite("git push --force origin main")).toBe(true);
    expect(looksLikeGitWrite("git -c x=y push")).toBe(true);
    expect(looksLikeGitWrite("git commit -m 'x'")).toBe(true);
    expect(looksLikeGitWrite("git reset --hard")).toBe(true);
  });

  it("allows reads", () => {
    expect(looksLikeGitWrite("git status")).toBe(false);
    expect(looksLikeGitWrite("git diff")).toBe(false);
    expect(looksLikeGitWrite("git log --oneline")).toBe(false);
    expect(looksLikeGitWrite("ls -la")).toBe(false);
  });
});
