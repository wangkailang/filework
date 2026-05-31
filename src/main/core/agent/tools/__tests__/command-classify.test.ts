import { describe, expect, it } from "vitest";

import { classifyCommand, parseTestStats } from "../command-classify";

describe("classifyCommand", () => {
  it("classifies common test runners as test", () => {
    for (const cmd of [
      "vitest run",
      "npx vitest",
      "pnpm test",
      "npm run test",
      "yarn test",
      "jest --ci",
      "pytest -q",
      "python -m pytest",
      "go test ./...",
      "cargo test",
      "playwright test",
      "deno test",
      "rspec",
      "phpunit",
      "dotnet test",
    ]) {
      expect(classifyCommand(cmd), cmd).toBe("test");
    }
  });

  it("classifies build/compile commands as build", () => {
    for (const cmd of [
      "tsc --noEmit",
      "npm run build",
      "pnpm build",
      "vite build",
      "go build ./...",
      "cargo build --release",
      "make",
      "webpack",
    ]) {
      expect(classifyCommand(cmd), cmd).toBe("build");
    }
  });

  it("falls back to generic for everything else", () => {
    for (const cmd of [
      "git status",
      "ls -la",
      "echo hello",
      "node script.js",
      "cat package.json",
    ]) {
      expect(classifyCommand(cmd), cmd).toBe("generic");
    }
  });

  it("prefers test over build when both keywords appear", () => {
    // `npm run build && npm test` — the run did include tests.
    expect(classifyCommand("npm run build && npm test")).toBe("test");
  });
});

describe("parseTestStats", () => {
  it("parses jest summary line", () => {
    const stdout = "Tests:       1 failed, 5 passed, 6 total\n";
    expect(parseTestStats(stdout, "")).toEqual({ passed: 5, failed: 1 });
  });

  it("parses vitest summary line", () => {
    const stdout = " Tests  3 passed | 1 failed (4)\n";
    expect(parseTestStats(stdout, "")).toEqual({ passed: 3, failed: 1 });
  });

  it("parses an all-passing vitest line (no failed token)", () => {
    const stdout = " Tests  7 passed (7)\n";
    expect(parseTestStats(stdout, "")).toEqual({ passed: 7, failed: 0 });
  });

  it("parses pytest summary", () => {
    const stdout = "===== 1 failed, 5 passed in 0.34s =====\n";
    expect(parseTestStats(stdout, "")).toEqual({ passed: 5, failed: 1 });
  });

  it("reads from stderr when stdout is empty", () => {
    expect(parseTestStats("", "2 passed\n")).toEqual({ passed: 2, failed: 0 });
  });

  it("returns undefined when no pass/fail counts present", () => {
    expect(parseTestStats("nothing to report\n", "")).toBeUndefined();
  });
});
