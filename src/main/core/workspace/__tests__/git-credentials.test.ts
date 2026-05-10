import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  __resetAskpassCacheForTests,
  __test__,
  buildAskpassEnv,
  ensureAskpassScript,
  githubSanitizedRemote,
  gitlabSanitizedRemote,
} from "../git-credentials";

describe("ensureAskpassScript", () => {
  let internalDir: string;

  beforeEach(async () => {
    internalDir = await mkdtemp(path.join(tmpdir(), "fw-askpass-"));
    __resetAskpassCacheForTests();
  });

  afterEach(async () => {
    await rm(internalDir, { recursive: true, force: true });
  });

  it("writes askpass.js with the expected script body", async () => {
    const scriptPath = await ensureAskpassScript(internalDir);
    expect(scriptPath).toBe(path.join(internalDir, "askpass.js"));
    const body = await readFile(scriptPath, "utf8");
    expect(body).toBe(__test__.ASKPASS_SCRIPT);
    expect(body).toContain("FILEWORK_GIT_PASSWORD");
    expect(body).toContain("process.exit(2)");
    expect(body.startsWith("#!/usr/bin/env node")).toBe(true);
  });

  it("sets the executable bit on POSIX", async () => {
    const scriptPath = await ensureAskpassScript(internalDir);
    if (process.platform !== "win32") {
      const st = await stat(scriptPath);
      // mode includes file-type bits; mask to permissions
      expect(st.mode & 0o111).not.toBe(0);
    }
  });

  it("is idempotent — second call returns the cached path without rewriting", async () => {
    const a = await ensureAskpassScript(internalDir);
    const b = await ensureAskpassScript(internalDir);
    expect(a).toBe(b);
  });
});

describe("buildAskpassEnv", () => {
  it("produces GIT_ASKPASS + FILEWORK_GIT_PASSWORD + GIT_TERMINAL_PROMPT=0", () => {
    const env = buildAskpassEnv({
      askpassPath: "/tmp/askpass.js",
      password: "secret-token",
      baseEnv: { PATH: "/usr/bin", EXISTING: "value" },
    });
    expect(env.GIT_ASKPASS).toBe("/tmp/askpass.js");
    expect(env.FILEWORK_GIT_PASSWORD).toBe("secret-token");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env.PATH).toBe("/usr/bin");
    expect(env.EXISTING).toBe("value");
  });

  it("inherits process.env when baseEnv is omitted", () => {
    const env = buildAskpassEnv({
      askpassPath: "/x",
      password: "p",
    });
    // PATH should be inherited from process.env (always present in tests)
    expect(env.PATH).toBe(process.env.PATH);
  });
});

describe("sanitized remote URL builders", () => {
  it("github URL has no token, only username", () => {
    const url = githubSanitizedRemote("acme", "app");
    expect(url).toBe("https://x-access-token@github.com/acme/app.git");
  });

  it("gitlab URL has no token, only username, includes host", () => {
    const url = gitlabSanitizedRemote("gitlab.example.com", "acme/sub", "app");
    expect(url).toBe("https://oauth2@gitlab.example.com/acme/sub/app.git");
  });
});
