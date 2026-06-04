/**
 * 市场 registry 客户端。
 *
 * 拉取自托管的 registry.json、按 schema 校验每个条目,并在
 * 内存中缓存结果(TTL)。校验失败的条目被静默丢弃,坏掉的
 * 单条不影响整张清单。
 */

import type { MarketEntry } from "./types";

/** registry.json 的托管地址(MVP 写死,后续可改为设置项)。 */
export const MARKETPLACE_REGISTRY_URL =
  "https://raw.githubusercontent.com/filework/skills-registry/main/registry.json";

type Fetcher = (url: string) => Promise<{
  ok: boolean;
  status?: number;
  json: () => Promise<unknown>;
}>;

interface FetchOpts {
  /** 注入的 fetch 实现(测试用);默认全局 fetch。 */
  fetcher?: Fetcher;
  /** 缓存有效期(毫秒)。0 表示禁用缓存。 */
  cacheMs?: number;
  /** 覆盖默认 registry 地址(测试 / 私有部署用)。 */
  url?: string;
}

interface CacheState {
  at: number;
  entries: MarketEntry[];
}

let cache: CacheState | null = null;

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

/**
 * 拉取并校验市场清单。命中缓存(在 TTL 内)时直接返回缓存,
 * 不重新请求。
 */
export async function fetchRegistry(
  opts: FetchOpts = {},
): Promise<MarketEntry[]> {
  const cacheMs = opts.cacheMs ?? 5 * 60_000;
  const now = Date.now();
  if (cache && cacheMs > 0 && now - cache.at < cacheMs) {
    return cache.entries;
  }

  const fetcher = opts.fetcher ?? (globalThis.fetch as Fetcher);
  const url = opts.url ?? MARKETPLACE_REGISTRY_URL;
  const res = await fetcher(url);
  if (!res.ok) {
    throw new Error(`registry fetch failed: HTTP ${res.status ?? "?"}`);
  }
  const payload = (await res.json()) as { entries?: unknown[] };
  const rawEntries = Array.isArray(payload?.entries) ? payload.entries : [];
  const entries = rawEntries.filter(validateEntry) as MarketEntry[];

  cache = { at: now, entries };
  return entries;
}

/** 清空内存缓存(测试 / 强制刷新用)。 */
export function clearRegistryCache(): void {
  cache = null;
}
