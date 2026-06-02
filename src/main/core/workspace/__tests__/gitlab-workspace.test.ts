import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ensureClone,
  type GitLabRef,
  GitLabWorkspace,
} from "../gitlab-workspace";

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

const fakeRef: GitLabRef = {
  kind: "gitlab",
  host: "gitlab.example.com",
  namespace: "acme/sub",
  project: "app",
  ref: "main",
  credentialId: "cred-1",
};

describe("ensureClone (GitLab)", () => {
  let cacheDir: string;

  beforeEach(async () => {
    cacheDir = await mkdtemp(path.join(tmpdir(), "fw-gl-cache-"));
  });

  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
  });

  it("clones with sanitized oauth2 URL (no token) + askpass env (M7)", async () => {
    const { fake, calls } = buildFakeSpawn();
    const expectedDir = path.join(
      cacheDir,
      "gitlab.example.com",
      "acme/sub",
      "app",
    );

    const result = await ensureClone(fakeRef, {
      resolveToken: async () => "glpat-TESTTOKEN",
      cacheDir,
      askpassPath: "/tmp/askpass.js",
      // biome-ignore lint/suspicious/noExplicitAny: test stub
      spawnFn: fake as any,
    });

    expect(result).toBe(expectedDir);
    const cloneCall = calls.find((c) => c.args[0] === "clone");
    // 新布局:部分克隆(无 --depth、无 --single-branch)。仍通过
    // --branch 固定分支,使初始检出匹配 ref.ref;后续切换走
    // SCM.checkoutBranch。
    expect(cloneCall?.args).toContain("--filter=blob:none");
    expect(cloneCall?.args).toContain("--branch");
    expect(cloneCall?.args).toContain("main");
    expect(cloneCall?.args).not.toContain("--depth");
    const remoteArg = cloneCall?.args[cloneCall.args.length - 2] ?? "";
    expect(remoteArg).not.toContain("glpat-TESTTOKEN");
    expect(remoteArg).toBe(
      "https://oauth2@gitlab.example.com/acme/sub/app.git",
    );
    expect(cloneCall?.env?.GIT_ASKPASS).toBe("/tmp/askpass.js");
    expect(cloneCall?.env?.FILEWORK_GIT_PASSWORD).toBe("glpat-TESTTOKEN");

    const stampStat = await stat(
      path.join(expectedDir, ".git/filework-last-fetch"),
    );
    expect(stampStat.isFile()).toBe(true);
  });

  it("re-fetches when stale", async () => {
    const cloneDir = path.join(
      cacheDir,
      "gitlab.example.com",
      "acme/sub",
      "app",
    );
    const stampPath = path.join(cloneDir, ".git/filework-last-fetch");
    await mkdir(path.join(cloneDir, ".git"), { recursive: true });
    await writeFile(stampPath, "2000-01-01T00:00:00.000Z", "utf8");
    const past = new Date("2000-01-01T00:00:00.000Z");
    await utimes(stampPath, past, past);

    const { fake, calls } = buildFakeSpawn();
    await ensureClone(fakeRef, {
      resolveToken: async () => "glpat-TESTTOKEN",
      cacheDir,
      freshnessTtlMs: 60_000,
      // biome-ignore lint/suspicious/noExplicitAny: test stub
      spawnFn: fake as any,
    });

    const subs = calls.map((c) => c.args[0]);
    expect(subs).toContain("remote");
    expect(subs).toContain("fetch");
    // 不再 reset --hard —— 工作树可能携带会话分支的提交,刷新时
    // 不能将其覆盖。
    expect(subs).not.toContain("reset");
  });

  it("skips git when fresh", async () => {
    const cloneDir = path.join(
      cacheDir,
      "gitlab.example.com",
      "acme/sub",
      "app",
    );
    await mkdir(path.join(cloneDir, ".git"), { recursive: true });
    await writeFile(
      path.join(cloneDir, ".git/filework-last-fetch"),
      new Date().toISOString(),
      "utf8",
    );

    const { fake, calls } = buildFakeSpawn();
    await ensureClone(fakeRef, {
      resolveToken: async () => "glpat-TESTTOKEN",
      cacheDir,
      freshnessTtlMs: 60_000,
      // biome-ignore lint/suspicious/noExplicitAny: test stub
      spawnFn: fake as any,
    });
    expect(calls.length).toBe(0);
  });
});

describe("GitLabWorkspace.create", () => {
  let cacheDir: string;

  beforeEach(async () => {
    cacheDir = await mkdtemp(path.join(tmpdir(), "fw-gl-cache-"));
  });

  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
  });

  it("constructs a Workspace with stable id and gitlab kind", async () => {
    const cloneDir = path.join(
      cacheDir,
      "gitlab.example.com",
      "acme/sub",
      "app",
    );
    await mkdir(path.join(cloneDir, ".git"), { recursive: true });
    await writeFile(
      path.join(cloneDir, ".git/filework-last-fetch"),
      new Date().toISOString(),
      "utf8",
    );
    await writeFile(path.join(cloneDir, "README.md"), "# hi\n", "utf8");

    const { fake } = buildFakeSpawn();
    const ws = await GitLabWorkspace.create(fakeRef, {
      resolveToken: async () => "glpat-T",
      cacheDir,
      freshnessTtlMs: 60_000,
      // biome-ignore lint/suspicious/noExplicitAny: test stub
      spawnFn: fake as any,
    });

    expect(ws.kind).toBe("gitlab");
    expect(ws.id).toBe("gitlab:gitlab.example.com:acme/sub/app@main");
    expect(ws.root).toBe(cloneDir);
    const readme = await ws.fs.readFile("README.md");
    expect(readme).toContain("hi");
  });

  it("normalizes a persisted https://-prefixed host (replayed pre-fix ref)", async () => {
    // 模拟在 host 归一化修复落地之前持久化的工作区 ref:`host` 是
    // 来自弹窗文本输入框的字面值 `https://gitlab.example.com/`。工厂
    // 通过 .create() 重放它,我们必须在构建克隆目录 / 远程 URL 前
    // 将其修正。
    const dirtyRef: GitLabRef = {
      ...fakeRef,
      host: "https://gitlab.example.com/",
    };
    const expectedCloneDir = path.join(
      cacheDir,
      "gitlab.example.com",
      "acme/sub",
      "app",
    );

    const { fake, calls } = buildFakeSpawn();
    const ws = await GitLabWorkspace.create(dirtyRef, {
      resolveToken: async () => "glpat-T",
      cacheDir,
      askpassPath: "/tmp/askpass.js",
      // biome-ignore lint/suspicious/noExplicitAny: test stub
      spawnFn: fake as any,
    });

    expect(ws.root).toBe(expectedCloneDir);
    expect(ws.id).toBe("gitlab:gitlab.example.com:acme/sub/app@main");

    const cloneCall = calls.find((c) => c.args[0] === "clone");
    expect(cloneCall).toBeDefined();
    const remoteUrl = cloneCall?.args.find((a) => a.startsWith("https://"));
    expect(remoteUrl).toBe(
      "https://oauth2@gitlab.example.com/acme/sub/app.git",
    );
  });
});
