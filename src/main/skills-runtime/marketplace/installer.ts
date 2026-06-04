/**
 * 市场 skill 安装器。
 *
 * 把一条 MarketEntry 落地到 <skillsRoot>/<id>/:
 * - git:浅克隆到临时目录,拷贝(可选)子目录;
 * - url:下载单个 SKILL.md。
 * 任意步骤失败都会删除半成品目录(回滚)。
 */

import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { GitSource, InstallResult, MarketEntry } from "./types";

const execFileAsync = promisify(execFile);

/** 安装后 skill 的默认根目录(= 现有 discovery 的 personal 源)。 */
export const DEFAULT_SKILLS_ROOT = join(homedir(), ".agents", "skills");

type Fetcher = (url: string) => Promise<{
  ok: boolean;
  status?: number;
  text: () => Promise<string>;
}>;

type RunGit = (args: string[], cwd: string) => Promise<void>;

interface InstallOpts {
  /** 安装根目录,默认 ~/.agents/skills。测试注入临时目录。 */
  skillsRoot?: string;
  /** 注入的下载实现(url 源)。 */
  fetcher?: Fetcher;
  /** 注入的 git 执行(git 源)。 */
  runGit?: RunGit;
}

const defaultRunGit: RunGit = async (args, cwd) => {
  await execFileAsync("git", args, { cwd, timeout: 120_000 });
};

/** 安装单条市场条目。失败时回滚目标目录。 */
export async function installEntry(
  entry: MarketEntry,
  opts: InstallOpts = {},
): Promise<InstallResult> {
  const skillsRoot = opts.skillsRoot ?? DEFAULT_SKILLS_ROOT;
  const target = join(skillsRoot, entry.id);

  try {
    await mkdir(target, { recursive: true });
    if (entry.source.type === "url") {
      await installFromUrl(entry.source.url, target, opts.fetcher);
    } else {
      await installFromGit(entry.source, target, opts.runGit);
    }
    return { ok: true, skillId: entry.id, installedPath: target };
  } catch (err) {
    await rm(target, { recursive: true, force: true }).catch(() => undefined);
    return {
      ok: false,
      skillId: entry.id,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function installFromUrl(
  url: string,
  target: string,
  fetcher?: Fetcher,
): Promise<void> {
  const f = fetcher ?? (globalThis.fetch as unknown as Fetcher);
  const res = await f(url);
  if (!res.ok) {
    throw new Error(`download failed: HTTP ${res.status ?? "?"}`);
  }
  const content = await res.text();
  await writeFile(join(target, "SKILL.md"), content, "utf-8");
}

async function installFromGit(
  source: GitSource,
  target: string,
  runGit?: RunGit,
): Promise<void> {
  const run = runGit ?? defaultRunGit;
  const clonePath = await mkdtemp(join(tmpdir(), "fw-clone-"));
  try {
    const args = ["clone", "--depth", "1"];
    if (source.ref) args.push("--branch", source.ref);
    args.push(source.repo, clonePath); // clonePath 为 args 末项,注入版据此取路径
    await run(args, tmpdir());

    const from = source.subdir ? join(clonePath, source.subdir) : clonePath;
    await cp(from, target, { recursive: true });
    await rm(join(target, ".git"), { recursive: true, force: true }).catch(
      () => undefined,
    );
  } finally {
    await rm(clonePath, { recursive: true, force: true }).catch(
      () => undefined,
    );
  }
}

/** 卸载一个 skill —— 删除其目录。 */
export async function uninstallSkill(
  skillId: string,
  opts: { skillsRoot?: string } = {},
): Promise<void> {
  const skillsRoot = opts.skillsRoot ?? DEFAULT_SKILLS_ROOT;
  await rm(join(skillsRoot, skillId), { recursive: true, force: true });
}
