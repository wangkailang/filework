import { describe, expect, it } from "vitest";

import {
  classifyCommand,
  isDeliverableCommand,
  parseTestStats,
} from "../command-classify";

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

describe("isDeliverableCommand", () => {
  it("treats file-mutating commands as deliverables", () => {
    for (const cmd of [
      "rm -rf node_modules",
      "mkdir dist",
      "mv a.txt b.txt",
      "cp a b",
      "zip -r out.zip folder",
      "tar -czf out.tar.gz ./src",
      "touch new.txt",
      "chmod +x run.sh",
      "ffmpeg -i in.mov out.mp4",
      "sips -Z 800 photo.png",
    ]) {
      expect(isDeliverableCommand(cmd), cmd).toBe(true);
    }
  });

  it("treats a write redirect as a deliverable", () => {
    expect(isDeliverableCommand("echo hello > out.txt")).toBe(true);
    expect(isDeliverableCommand("cat a b >> merged.txt")).toBe(true);
  });

  it("ignores fd-dups and /dev/null redirects", () => {
    expect(isDeliverableCommand("ls 2>&1")).toBe(false);
    expect(isDeliverableCommand("grep foo src 2>/dev/null")).toBe(false);
  });

  it("treats read-only inspections as non-deliverables", () => {
    for (const cmd of [
      "ls -la",
      "du -sh .",
      "cat package.json",
      "find . -name '*.ts'",
      "df -h",
      'grep -r "foo" src',
      // the reported find | while ... stat inspection
      'find . -type f | while read f; do echo "$(stat -f%z "$f") ${f##*.}"; done',
      // compute disk usage via python
      'cd "/x/folder" && python3 -c "import os; ' +
        "print(sum(os.path.getsize(os.path.join(d, f)) for d, _, fs in " +
        "os.walk('.') for f in fs))\"",
    ]) {
      expect(isDeliverableCommand(cmd), cmd).toBe(false);
    }
  });

  it("distinguishes mutating vs read-only git subcommands", () => {
    expect(isDeliverableCommand("git status")).toBe(false);
    expect(isDeliverableCommand("git log --oneline")).toBe(false);
    expect(isDeliverableCommand("git add .")).toBe(true);
    expect(isDeliverableCommand("git commit -m x")).toBe(true);
  });

  it("treats a mutating interpreter snippet as a deliverable", () => {
    expect(
      isDeliverableCommand(
        "cd folder && python3 -c \"import os; os.remove('x')\"",
      ),
    ).toBe(true);
    expect(
      isDeliverableCommand("python3 -c \"open('out.txt', 'w').write(data)\""),
    ).toBe(true);
  });

  it("treats sed -i (in-place) as mutating but plain sed as not", () => {
    expect(isDeliverableCommand("sed -i '' s/a/b/ file.txt")).toBe(true);
    expect(isDeliverableCommand("sed s/a/b/ file.txt")).toBe(false);
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
