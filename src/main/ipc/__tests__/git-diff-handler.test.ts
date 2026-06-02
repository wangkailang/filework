/**
 * 集成测试:用 mkdtemp 创建一个真实的 git 仓库,填充一个分支,
 * 然后走一遍 handler 所用的同一条 `runGit` + `parsePatch` 流水线。
 * IPC 桥接本身则通过 E2E 测试覆盖。
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
    // 说明 handler *为何* 需要 `collectUntrackedDiffs`:单纯的
    // `git diff <base>` 对未跟踪内容只字不提。下面的
    // ls-files + diff --no-index 测试补全了这一闭环。
    await writeFile(path.join(root, "README.md"), "# Hello\nline\nedited\n");
    await writeFile(path.join(root, "new.txt"), "fresh\n");

    const baseSha = (await git(["merge-base", "main", "HEAD"])).trim();
    const headSha = (await git(["rev-parse", "HEAD"])).trim();
    expect(baseSha).toBe(headSha); // 分支上尚无提交

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
    expect(paths).not.toContain("new.txt"); // 印证 diff 的盲区
  });

  it("ls-files --others --exclude-standard surfaces untracked, respects .gitignore", async () => {
    // handler 的 `collectUntrackedDiffs` 使用了这条命令 —— 固化其
    // 行为,以免将来某次标志变更悄悄地重新纳入被 gitignore 的
    // 噪声(node_modules、dist 等)。
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
    // 针对未跟踪文件的合成步骤。退出码 1 是
    // 正常的“文件存在差异”结果 —— handler 必须容忍它。
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
    expect(res.exitCode).toBe(1); // “存在差异” —— 预期的非零退出码
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
