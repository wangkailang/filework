import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ensureClone,
  type GitHubRef,
  GitHubWorkspace,
} from "../github-workspace";

/**
 * 构造一个模拟的 `spawn`,记录每次调用并按 `git` 子命令回放预设的
 * 退出码。使我们能够在不接触网络的情况下测试 ensureClone 与
 * GitHubWorkspace。
 */
const buildFakeSpawn = () => {
  const calls: Array<{
    args: string[];
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  }> = [];
  const fake = vi.fn(
    (
      _cmd: string,
      args: string[],
      opts?: { cwd?: string; env?: NodeJS.ProcessEnv },
    ) => {
      calls.push({ args, cwd: opts?.cwd, env: opts?.env });
      const proc = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
      };
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      // 实际创建 .git 目录,使调用返回后 cloneExists() 返回 true
      // (与真实 git 的行为一致)。
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

  it("clones with sanitized URL (no token) and supplies token via askpass env (M7)", async () => {
    const { fake, calls } = buildFakeSpawn();
    const expectedDir = path.join(cacheDir, "acme", "app");

    const result = await ensureClone(fakeRef, {
      resolveToken: async () => "ghp_TESTTOKEN",
      cacheDir,
      askpassPath: "/tmp/askpass.js",
      // biome-ignore lint/suspicious/noExplicitAny: test stub for spawn
      spawnFn: fake as any,
    });

    expect(result).toBe(expectedDir);
    const cloneCall = calls.find((c) => c.args[0] === "clone");
    expect(cloneCall).toBeDefined();
    // 新布局:部分克隆(无 --depth/--single-branch)。仍通过 --branch
    // 固定分支,使初始检出与 ref.ref 匹配;后续切换走
    // SCM.checkoutBranch。
    expect(cloneCall?.args).toContain("--filter=blob:none");
    expect(cloneCall?.args).toContain("--branch");
    expect(cloneCall?.args).toContain("main");
    expect(cloneCall?.args).not.toContain("--depth");
    const remoteArg = cloneCall?.args[cloneCall.args.length - 2] ?? "";
    // M7:token 绝不能出现在远程 URL 中。
    expect(remoteArg).not.toContain("ghp_TESTTOKEN");
    expect(remoteArg).toBe("https://x-access-token@github.com/acme/app.git");
    // token 改为通过环境变量提供。
    expect(cloneCall?.env?.GIT_ASKPASS).toBe("/tmp/askpass.js");
    expect(cloneCall?.env?.FILEWORK_GIT_PASSWORD).toBe("ghp_TESTTOKEN");
    expect(cloneCall?.env?.GIT_TERMINAL_PROMPT).toBe("0");

    const stampStat = await stat(
      path.join(expectedDir, ".git/filework-last-fetch"),
    );
    expect(stampStat.isFile()).toBe(true);
  });

  it("skips git when the existing clone is fresh", async () => {
    const cloneDir = path.join(cacheDir, "acme", "app");
    await mkdir(path.join(cloneDir, ".git"), { recursive: true });
    await writeFile(
      path.join(cloneDir, ".git/filework-last-fetch"),
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
    const cloneDir = path.join(cacheDir, "acme", "app");
    const stampPath = path.join(cloneDir, ".git/filework-last-fetch");
    await mkdir(path.join(cloneDir, ".git"), { recursive: true });
    await writeFile(stampPath, "2000-01-01T00:00:00.000Z", "utf8");
    // 强制把标记文件的 mtime 设到过去 —— 仅依赖 `freshnessTtlMs:0` 在快速磁盘上
    // 存在竞态:writeFile 后可能 Date.now() == st.mtimeMs,使 `(0 < 0)` 求值为
    // false,从而错误地报告为新鲜。
    const past = new Date("2000-01-01T00:00:00.000Z");
    await utimes(stampPath, past, past);

    const { fake, calls } = buildFakeSpawn();
    await ensureClone(fakeRef, {
      resolveToken: async () => "ghp_TESTTOKEN",
      cacheDir,
      freshnessTtlMs: 60_000,
      // biome-ignore lint/suspicious/noExplicitAny: test stub for spawn
      spawnFn: fake as any,
    });

    const subs = calls.map((c) => c.args[0]);
    expect(subs).toContain("remote");
    expect(subs).toContain("fetch");
    // 刷新时不执行 reset --hard —— 保留会话分支上的提交。
    expect(subs).not.toContain("reset");
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
    const cloneDir = path.join(cacheDir, "acme", "app");
    await mkdir(cloneDir, { recursive: true });
    await mkdir(path.join(cloneDir, ".git"), { recursive: true });
    await writeFile(
      path.join(cloneDir, ".git/filework-last-fetch"),
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
});
