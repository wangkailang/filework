/**
 * 市场 skill 安装器。
 *
 * 把一条 MarketEntry 落地到 <skillsRoot>/<id>/:
 * - git:浅克隆到临时目录,拷贝(可选)子目录;
 * - url:下载单个 SKILL.md。
 * 任意步骤失败都会删除半成品目录(回滚)。
 */

import { execFile } from "node:child_process";
import { access, cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { promisify } from "node:util";

import type { GitSource, InstallResult, MarketEntry } from "./types";

const execFileAsync = promisify(execFile);

/** 确保 target 解析后仍在 root 之内,挡掉来自远端 registry 的路径穿越(如 id="../../etc")。 */
function assertInsideRoot(root: string, target: string): void {
  const rel = relative(root, target);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`unsafe path escapes root: ${target}`);
  }
}

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

  // 是否已存在一个「有效的」既装 skill(目标根有 SKILL.md)。回滚只保护它,
  // 不保护空目录 / 上次失败安装留下的残骸 —— 后者必须被清掉,否则下次安装会
  // cp 合并到残骸上得到一个损坏的 skill 目录。
  let preexisted = false;

  try {
    // 防止远端 registry 中的恶意 id(如 "../../etc")穿越到 skillsRoot 之外
    assertInsideRoot(skillsRoot, target);

    preexisted = await access(join(target, "SKILL.md"))
      .then(() => true)
      .catch(() => false);

    await mkdir(target, { recursive: true });
    if (entry.source.type === "url") {
      await installFromUrl(entry.source.url, target, opts.fetcher);
    } else {
      await installFromGit(entry.source, target, opts.runGit);
    }
    // 强制约定:安装后 SKILL.md 必须位于 <target>/SKILL.md,否则发现器推出的
    // skillId 会与 entry.id 不符,导致启用/已装/信任键错配。
    const { existsSync } = await import("node:fs");
    if (!existsSync(join(target, "SKILL.md"))) {
      throw new Error(
        "installed skill has no SKILL.md at its root (check source subdir)",
      );
    }
    return { ok: true, skillId: entry.id, installedPath: target };
  } catch (err) {
    if (!preexisted) {
      await rm(target, { recursive: true, force: true }).catch(() => undefined);
    }
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
  if (typeof f !== "function") {
    throw new Error("no fetch available in this environment");
  }
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
    // 只在有 subdir 时校验,防止远端注入 "../../etc" 类路径
    if (source.subdir) assertInsideRoot(clonePath, from);
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
  const target = join(skillsRoot, skillId);
  // 防止恶意 skillId 穿越到 skillsRoot 之外(会 throw,不静默)
  assertInsideRoot(skillsRoot, target);
  await rm(target, { recursive: true, force: true });
}
