import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __test__,
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
      "app@main",
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
    expect(cloneCall?.args).toContain("--depth");
    expect(cloneCall?.args).toContain("1");
    expect(cloneCall?.args).toContain("--branch");
    expect(cloneCall?.args).toContain("main");
    const remoteArg = cloneCall?.args[cloneCall.args.length - 2] ?? "";
    // M7: token MUST NOT appear in the URL.
    expect(remoteArg).not.toContain("glpat-TESTTOKEN");
    expect(remoteArg).toBe(
      "https://oauth2@gitlab.example.com/acme/sub/app.git",
    );
    expect(cloneCall?.env?.GIT_ASKPASS).toBe("/tmp/askpass.js");
    expect(cloneCall?.env?.FILEWORK_GIT_PASSWORD).toBe("glpat-TESTTOKEN");

    const stampStat = await stat(path.join(expectedDir, ".last-fetch"));
    expect(stampStat.isFile()).toBe(true);
  });

  it("re-fetches when stale", async () => {
    const cloneDir = path.join(
      cacheDir,
      "gitlab.example.com",
      "acme/sub",
      "app@main",
    );
    const stampPath = path.join(cloneDir, ".last-fetch");
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
    expect(subs).toContain("reset");
  });

  it("skips git when fresh", async () => {
    const cloneDir = path.join(
      cacheDir,
      "gitlab.example.com",
      "acme/sub",
      "app@main",
    );
    await mkdir(path.join(cloneDir, ".git"), { recursive: true });
    await writeFile(
      path.join(cloneDir, ".last-fetch"),
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
      "app@main",
    );
    await mkdir(path.join(cloneDir, ".git"), { recursive: true });
    await writeFile(
      path.join(cloneDir, ".last-fetch"),
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

  it("blocks `git push`-style commands via exec", async () => {
    const cloneDir = path.join(
      cacheDir,
      "gitlab.example.com",
      "acme/sub",
      "app@main",
    );
    await mkdir(path.join(cloneDir, ".git"), { recursive: true });
    await writeFile(
      path.join(cloneDir, ".last-fetch"),
      new Date().toISOString(),
      "utf8",
    );

    const { fake } = buildFakeSpawn();
    const ws = await GitLabWorkspace.create(fakeRef, {
      resolveToken: async () => "glpat-T",
      cacheDir,
      freshnessTtlMs: 60_000,
      // biome-ignore lint/suspicious/noExplicitAny: test stub
      spawnFn: fake as any,
    });

    const result = await ws.exec.run("git push origin main");
    expect(result.exitCode).toBe(126);
    expect(result.stderr).toContain("typed");
  });
});

describe("__test__ helpers", () => {
  it("projectIdEncoded escapes / in the namespace path", () => {
    const id = __test__.projectIdEncoded({
      cloneDir: "",
      baseBranch: "main",
      host: "gitlab.com",
      namespace: "group/sub",
      project: "myproj",
      resolveToken: async () => "",
      sessionScope: "",
    });
    expect(id).toBe("group%2Fsub%2Fmyproj");
  });

  it("glStateOut maps open→opened, others pass through", () => {
    expect(__test__.glStateOut("open")).toBe("opened");
    expect(__test__.glStateOut("closed")).toBe("closed");
    expect(__test__.glStateOut("all")).toBe("all");
  });

  it("mapMrState derives merged from merged_at", () => {
    expect(__test__.mapMrState("opened", null)).toBe("open");
    expect(__test__.mapMrState("closed", null)).toBe("closed");
    expect(__test__.mapMrState("locked", null)).toBe("closed");
    expect(__test__.mapMrState("merged", "2026-05-01T00:00:00Z")).toBe(
      "merged",
    );
    expect(__test__.mapMrState("closed", "2026-05-01T00:00:00Z")).toBe(
      "merged",
    );
  });

  it("fallbackSessionScope is deterministic per ref", () => {
    const a = __test__.fallbackSessionScope(fakeRef);
    const b = __test__.fallbackSessionScope(fakeRef);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}$/);
  });
});
