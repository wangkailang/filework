/**
 * 市场 registry 客户端。
 *
 * 直接读取随 app 打包的本地 registry.json,按 schema 逐条校验,
 * 校验失败的单条被静默丢弃,不影响整张清单。上新 skill 需改本文件
 * 同目录的 registry.json 并随版本发布。
 */

import registryData from "./registry.json";
import type { MarketEntry } from "./types";

/**
 * 只允许 https / ssh(scp 简写 git@host:path 或 ssh://)形式的 git 仓库地址,
 * 挡掉 git 的危险传输(ext::、file::、- 开头会被当作选项等)。
 */
function isSafeGitRepo(repo: string): boolean {
  if (repo.startsWith("-")) return false;
  if (/^https:\/\//i.test(repo)) return true;
  if (/^ssh:\/\//i.test(repo)) return true;
  if (/^git@[\w.-]+:/.test(repo)) return true; // git@github.com:owner/repo.git
  return false;
}

/** 按 MarketEntry schema 校验一个未知对象。 */
export function validateEntry(raw: unknown): raw is MarketEntry {
  if (!raw || typeof raw !== "object") return false;
  const e = raw as Record<string, unknown>;
  if (typeof e.id !== "string" || !e.id) return false;
  if (typeof e.name !== "string" || !e.name) return false;
  if (typeof e.description !== "string") return false;
  if (e.level !== "official" && e.level !== "community") return false;
  const src = e.source as Record<string, unknown> | undefined;
  if (!src || typeof src !== "object") return false;
  if (src.type === "git") {
    if (typeof src.repo !== "string" || !src.repo) return false;
    if (!isSafeGitRepo(src.repo)) return false;
    if (
      src.ref !== undefined &&
      (typeof src.ref !== "string" || src.ref.startsWith("-"))
    ) {
      return false;
    }
    if (src.subdir !== undefined && typeof src.subdir !== "string")
      return false;
  } else if (src.type === "url") {
    if (typeof src.url !== "string" || !src.url) return false;
    if (!/^https:\/\//i.test(src.url)) return false; // 仅允许 https 单文件直链
  } else {
    return false;
  }
  return true;
}

interface RegistryOpts {
  /** 覆盖默认 registry 数据(测试用);默认本地打包的 registry.json。 */
  source?: unknown;
}

/** 读取并校验本地市场清单,只返回通过校验的条目。 */
export function getRegistry(opts: RegistryOpts = {}): MarketEntry[] {
  const data = (opts.source ?? registryData) as { entries?: unknown[] };
  const rawEntries = Array.isArray(data?.entries) ? data.entries : [];
  return rawEntries.filter(validateEntry) as MarketEntry[];
}

/**
 * 兼容旧调用方的异步入口。本地读取不会失败,直接包成 Promise 返回。
 */
export async function fetchRegistry(
  opts: RegistryOpts = {},
): Promise<MarketEntry[]> {
  return getRegistry(opts);
}
