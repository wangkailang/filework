/**
 * Integration test: spin up a real git repo with mkdtemp, populate a
 * branch, then exercise the same `runGit` + `parsePatch` pipeline the
 * handler uses. The IPC bridge itself is exercised via E2E.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parsePatch } from "diff";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runGit } from "../../core/workspace/clone-cache";

describe("git diff against branch base", () => {
  let root: string;

  const git = async (args: string[]): Promise<string> => {
    const r = await runGit(args, { cwd: root });
    if (r.exitCode !== 0) {
      throw new Error(
        `git ${args.join(" ")} exited ${r.exitCode}: ${r.stderr}`,
      );
    }
    return r.stdout;
  };

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "fw-branchdiff-"));
    await git(["init", "-q", "--initial-branch=main"]);
    await git(["config", "user.email", "test@example.com"]);
    await git(["config", "user.name", "test"]);
    await writeFile(path.join(root, "README.md"), "# Hello\nline\n");
    await git(["add", "."]);
    await git(["commit", "-q", "-m", "base"]);
    await git(["checkout", "-q", "-b", "feature"]);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("produces a parseable patch with both modified and added files", async () => {
    await writeFile(path.join(root, "README.md"), "# Hello\nline\nextra\n");
    await writeFile(path.join(root, "new.txt"), "fresh\n");
    await git(["add", "."]);
    await git(["commit", "-q", "-m", "edit"]);

    const baseSha = (await git(["merge-base", "main", "HEAD"])).trim();
    const diff = await git([
      "diff",
      "--no-color",
      "-U3",
      "--find-renames",
      baseSha,
    ]);
    const parsed = parsePatch(diff);
    const paths = parsed
      .map((p) => p.newFileName?.replace(/^b\//, ""))
      .filter(Boolean);
    expect(paths).toContain("README.md");
    expect(paths).toContain("new.txt");
  });

  it("name-status reports renames", async () => {
    await git(["mv", "README.md", "DOCS.md"]);
    await git(["commit", "-q", "-m", "rename"]);

    const baseSha = (await git(["merge-base", "main", "HEAD"])).trim();
    const ns = await git([
      "diff",
      "--no-color",
      "--name-status",
      "--find-renames",
      baseSha,
    ]);
    expect(ns).toMatch(/^R\d+\tREADME\.md\tDOCS\.md/);
  });

  it("merge-base equals HEAD when branch matches main", async () => {
    await git(["checkout", "-q", "main"]);
    const mb = (await git(["merge-base", "main", "HEAD"])).trim();
    const head = (await git(["rev-parse", "HEAD"])).trim();
    expect(mb).toBe(head);
  });

  it("git diff alone misses untracked files — handler must compose with ls-files", async () => {
    // Documents *why* the handler needs `collectUntrackedDiffs`: plain
    // `git diff <base>` is silent about untracked content. The
    // ls-files + diff --no-index tests below cover the closure.
    await writeFile(path.join(root, "README.md"), "# Hello\nline\nedited\n");
    await writeFile(path.join(root, "new.txt"), "fresh\n");

    const baseSha = (await git(["merge-base", "main", "HEAD"])).trim();
    const headSha = (await git(["rev-parse", "HEAD"])).trim();
    expect(baseSha).toBe(headSha); // no commits on branch yet

    const diff = await git([
      "diff",
      "--no-color",
      "-U3",
      "--find-renames",
      baseSha,
    ]);
    const parsed = parsePatch(diff);
    const paths = parsed
      .map((p) => p.newFileName?.replace(/^b\//, ""))
      .filter(Boolean);
    expect(paths).toContain("README.md");
    expect(paths).not.toContain("new.txt"); // confirms diff blind spot
  });

  it("ls-files --others --exclude-standard surfaces untracked, respects .gitignore", async () => {
    // The handler's `collectUntrackedDiffs` uses this command — pin
    // behavior so a future flag change doesn't silently re-include
    // gitignored noise (node_modules, dist, etc.).
    await writeFile(path.join(root, ".gitignore"), "ignored.txt\n");
    await git(["add", ".gitignore"]);
    await git(["commit", "-q", "-m", "add gitignore"]);

    await writeFile(path.join(root, "new.txt"), "fresh\n");
    await writeFile(path.join(root, "ignored.txt"), "noise\n");

    const ls = await git(["ls-files", "--others", "--exclude-standard", "-z"]);
    const paths = ls.split("\0").filter((p) => p.length > 0);
    expect(paths).toContain("new.txt");
    expect(paths).not.toContain("ignored.txt");
  });

  it("git diff --no-index /dev/null <file> produces an added-file patch parsePatch can read", async () => {
    // The synthesis step for untracked files. Exit code 1 is the
    // normal "files differ" outcome — handler must tolerate it.
    await writeFile(path.join(root, "fresh.txt"), "alpha\nbeta\ngamma\n");

    const res = await runGit(
      [
        "diff",
        "--no-index",
        "--no-color",
        "-U3",
        "--",
        "/dev/null",
        "fresh.txt",
      ],
      { cwd: root },
    );
    expect(res.exitCode).toBe(1); // "they differ" — the expected non-zero
    expect(res.stdout).toMatch(/--- a?\/?dev\/null/);
    expect(res.stdout).toMatch(/\+\+\+ b\/fresh\.txt/);

    const parsed = parsePatch(res.stdout);
    expect(parsed).toHaveLength(1);
    const hunks = parsed[0]?.hunks ?? [];
    const addedLines = hunks
      .flatMap((h) => h.lines)
      .filter((l) => l.startsWith("+"));
    expect(addedLines).toEqual(["+alpha", "+beta", "+gamma"]);
  });

  it("rev-parse exits non-zero outside a git repo", async () => {
    const outside = await mkdtemp(path.join(tmpdir(), "fw-not-git-"));
    try {
      const r = await runGit(["rev-parse", "--is-inside-work-tree"], {
        cwd: outside,
      });
      expect(r.exitCode).not.toBe(0);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
