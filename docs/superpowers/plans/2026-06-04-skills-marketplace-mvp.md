# Skills 市场 MVP 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 filework 加一个轻量 Skills 市场:从自托管 `registry.json` 浏览并一键安装 skill 到 `~/.agents/skills/`,安装时审批并把信任持久化到 SQLite。

**Architecture:** 新增 `src/main/skills-runtime/marketplace/` 三个模块(registry-client / installer / index),安装只负责把文件落到 `~/.agents/skills/<skillId>/`,之后复用现有 discovery → registry 管线。信任从内存 Map 迁移到新 SQLite 表 `skill_trust`。UI 在现有 `SkillsModal` 加「市场」tab。

**Tech Stack:** Electron + TypeScript(主进程)、better-sqlite3 + Drizzle(已有)、React + Tailwind(渲染)、vitest(测试)、typesafe-i18n。

设计来源:`docs/superpowers/specs/2026-06-04-skills-marketplace-mvp-design.md`

---

## ⚠️ 架构修正(Task 3 执行中发现,已采纳)

`better-sqlite3` 是按 **Electron ABI** 编译的原生模块,无法在 vitest/Node 下加载;项目原本就**没有任何 db 单测**。决定:**跟随该惯例,不做 db 单测**。直接推论 ——

> **任何 `import` 了 db 模块的代码都不能有 Node 单测**(require 原生模块即抛 ABI 错)。因此把所有碰 SQLite 的代码限制在 **Electron-only、不做 Node 单测**的 IPC / 初始化层。

落到本计划:
- `marketplace/*`(registry-client / installer / index)与 `security.ts` **保持不 import db**、纯函数、Node 可测。
- `marketplace/index.ts` 的 `installMarketSkill` **不写信任**,只安装文件 + 计算 hash 并把 hash 一并返回;`uninstallMarketSkill` 只删目录。
- `security.ts` 仍用内存 `trustStore`(现有 Node 测试不破),新增纯函数 `recordTrust` / `hydrateTrust` 供外部灌入。
- `skill_trust` 的读写(`upsert/delete/listSkillTrust`)+ 启动灌入 + 安装写库,**全部在 Electron 侧的 `ai-handlers` 完成**(Task 6),不单测。
- Task 3 已按此改为 **Drizzle schema + Drizzle CRUD**(`schema.skillTrust`,`mode:"boolean"` 自动映射),不再用 raw sqlite,无模块级重构。

Task 4 / 5 / 6 的描述以本节为准(下文旧描述中"security.ts 改为走 DB""index.ts 写信任"等已被本节覆盖)。

---

## 文件结构

**新建**
- `src/main/skills-runtime/marketplace/types.ts` — `MarketEntry`、`MarketEntryWithStatus`、`InstallResult` 类型
- `src/main/skills-runtime/marketplace/registry-client.ts` — 拉取 + 缓存 + 校验 registry.json
- `src/main/skills-runtime/marketplace/installer.ts` — git / url 两种安装 + 卸载 + 回滚
- `src/main/skills-runtime/marketplace/index.ts` — 编排 list / install / uninstall
- `src/main/skills-runtime/marketplace/__tests__/registry-client.test.ts`
- `src/main/skills-runtime/marketplace/__tests__/installer.test.ts`
- `src/main/skills-runtime/marketplace/__tests__/index.test.ts`
- `src/main/db/__tests__/skill-trust.test.ts`

**修改**
- `src/main/db/index.ts` — 新增 `skill_trust` 表 + CRUD
- `src/main/skills-runtime/security.ts` — 信任读写从内存 Map 改为走 DB CRUD
- `src/main/skills-runtime/registry.ts` — 新增 `refreshPersonalSkills()`
- `src/main/skills-runtime/index.ts` — 导出 marketplace API
- `src/main/ipc/ai-handlers.ts` — 新增 `market:list/install/uninstall` 三个通道
- `src/preload/index.ts` — 暴露 `marketList/marketInstall/marketUninstall`
- `src/renderer/components/skills/SkillsModal.tsx` — 「市场」tab + 安装确认
- `src/renderer/i18n/`(已有 locale 文件)— 新增 `skillsModal_market*` 文案键

> registry.json 的托管地址先写死常量 `MARKETPLACE_REGISTRY_URL`(放 registry-client.ts 顶部),后续可改为设置项。MVP 用一个占位 GitHub raw URL,测试通过注入 fetcher 绕开网络。

---

## Task 1: MarketEntry 类型与 registry-client

**Files:**
- Create: `src/main/skills-runtime/marketplace/types.ts`
- Create: `src/main/skills-runtime/marketplace/registry-client.ts`
- Test: `src/main/skills-runtime/marketplace/__tests__/registry-client.test.ts`

- [ ] **Step 1: 写类型文件**

`src/main/skills-runtime/marketplace/types.ts`:
```ts
/** 市场来源等级 —— 影响安装时的信任警示文案。 */
export type MarketLevel = "official" | "community";

/** git 子目录安装来源。 */
export interface GitSource {
  type: "git";
  repo: string;
  ref?: string;
  subdir?: string;
}

/** 单文件 SKILL.md 直链来源。 */
export interface UrlSource {
  type: "url";
  url: string;
}

/** registry.json 中的单条市场条目。 */
export interface MarketEntry {
  id: string;
  name: string;
  description: string;
  version?: string;
  level: MarketLevel;
  source: GitSource | UrlSource;
  requires?: { bins?: string[]; env?: string[]; os?: string[]; pip?: string[] };
  homepage?: string;
}

/** 附带本地安装状态的市场条目(供 UI 使用)。 */
export interface MarketEntryWithStatus extends MarketEntry {
  installed: boolean;
}

/** 安装结果。 */
export interface InstallResult {
  ok: boolean;
  skillId: string;
  installedPath?: string;
  error?: string;
}
```

- [ ] **Step 2: 写失败测试**

`src/main/skills-runtime/marketplace/__tests__/registry-client.test.ts`:
```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearRegistryCache, fetchRegistry, validateEntry } from "../registry-client";

beforeEach(() => clearRegistryCache());

const goodEntry = {
  id: "pdf-tools",
  name: "PDF Tools",
  description: "Parse PDFs",
  level: "official",
  source: { type: "git", repo: "https://github.com/x/y", subdir: "pdf-tools" },
};

describe("validateEntry", () => {
  it("accepts a well-formed git entry", () => {
    expect(validateEntry(goodEntry)).toBe(true);
  });

  it("rejects an entry missing id", () => {
    const { id, ...rest } = goodEntry;
    expect(validateEntry(rest)).toBe(false);
  });

  it("rejects an entry with unknown source type", () => {
    expect(validateEntry({ ...goodEntry, source: { type: "ftp" } })).toBe(false);
  });

  it("rejects an entry with invalid level", () => {
    expect(validateEntry({ ...goodEntry, level: "trusted" })).toBe(false);
  });
});

describe("fetchRegistry", () => {
  it("returns only valid entries from the payload", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ entries: [goodEntry, { id: "broken" }] }),
    });
    const entries = await fetchRegistry({ fetcher, cacheMs: 0 });
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe("pdf-tools");
  });

  it("caches within TTL and does not re-fetch", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ entries: [goodEntry] }),
    });
    await fetchRegistry({ fetcher, cacheMs: 60_000 });
    await fetchRegistry({ fetcher, cacheMs: 60_000 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("throws on a non-ok response", async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    await expect(fetchRegistry({ fetcher, cacheMs: 0 })).rejects.toThrow();
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `pnpm vitest run src/main/skills-runtime/marketplace/__tests__/registry-client.test.ts`
Expected: FAIL — `fetchRegistry`/`validateEntry`/`clearRegistryCache` 未定义。

- [ ] **Step 4: 写实现**

`src/main/skills-runtime/marketplace/registry-client.ts`:
```ts
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
  url?: string;
}

interface CacheState {
  at: number;
  entries: MarketEntry[];
}

let cache: CacheState | null = null;

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
  } else if (src.type === "url") {
    if (typeof src.url !== "string" || !src.url) return false;
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
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm vitest run src/main/skills-runtime/marketplace/__tests__/registry-client.test.ts`
Expected: PASS(7 个用例)。

- [ ] **Step 6: Commit**

```bash
git add src/main/skills-runtime/marketplace/types.ts \
  src/main/skills-runtime/marketplace/registry-client.ts \
  src/main/skills-runtime/marketplace/__tests__/registry-client.test.ts
git commit -m "feat(skills-market): registry-client 拉取/校验/缓存 + MarketEntry 类型"
```

---

## Task 2: installer(git / url 安装 + 卸载 + 回滚)

**Files:**
- Create: `src/main/skills-runtime/marketplace/installer.ts`
- Test: `src/main/skills-runtime/marketplace/__tests__/installer.test.ts`

- [ ] **Step 1: 写失败测试**

`src/main/skills-runtime/marketplace/__tests__/installer.test.ts`:
```ts
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installEntry, uninstallSkill } from "../installer";
import type { MarketEntry } from "../types";

let skillsRoot: string;

beforeEach(() => {
  skillsRoot = mkdtempSync(join(tmpdir(), "fw-skills-"));
});
afterEach(() => {
  rmSync(skillsRoot, { recursive: true, force: true });
});

describe("installEntry — url source", () => {
  it("downloads a single SKILL.md into <root>/<id>/", async () => {
    const entry: MarketEntry = {
      id: "hello",
      name: "Hello",
      description: "d",
      level: "community",
      source: { type: "url", url: "https://example.com/SKILL.md" },
    };
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => "---\nname: hello\n---\nbody",
    });
    const res = await installEntry(entry, { skillsRoot, fetcher });
    expect(res.ok).toBe(true);
    const md = await readFile(join(skillsRoot, "hello", "SKILL.md"), "utf-8");
    expect(md).toContain("name: hello");
  });

  it("rolls back the dir on a failed download", async () => {
    const entry: MarketEntry = {
      id: "bad",
      name: "Bad",
      description: "d",
      level: "community",
      source: { type: "url", url: "https://example.com/SKILL.md" },
    };
    const fetcher = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    const res = await installEntry(entry, { skillsRoot, fetcher });
    expect(res.ok).toBe(false);
    expect(existsSync(join(skillsRoot, "bad"))).toBe(false);
  });
});

describe("installEntry — git source", () => {
  it("invokes git clone then copies the subdir", async () => {
    const entry: MarketEntry = {
      id: "gitskill",
      name: "Git Skill",
      description: "d",
      level: "official",
      source: { type: "git", repo: "https://github.com/x/y", subdir: "sub" },
    };
    // runGit 注入:从 args 末项取 clone 路径,在其中铺好 sub/SKILL.md
    const runGit = vi.fn(async (args: string[]) => {
      const clone = args[args.length - 1];
      mkdirSync(join(clone, "sub"), { recursive: true });
      writeFileSync(join(clone, "sub", "SKILL.md"), "---\nname: gitskill\n---\nb");
    });
    const res = await installEntry(entry, { skillsRoot, runGit });
    expect(res.ok).toBe(true);
    expect(existsSync(join(skillsRoot, "gitskill", "SKILL.md"))).toBe(true);
  });
});

describe("uninstallSkill", () => {
  it("removes the skill dir", async () => {
    mkdirSync(join(skillsRoot, "gone"), { recursive: true });
    writeFileSync(join(skillsRoot, "gone", "SKILL.md"), "x");
    await uninstallSkill("gone", { skillsRoot });
    expect(existsSync(join(skillsRoot, "gone"))).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run src/main/skills-runtime/marketplace/__tests__/installer.test.ts`
Expected: FAIL — `installEntry`/`uninstallSkill` 未定义。

- [ ] **Step 3: 写实现**

`src/main/skills-runtime/marketplace/installer.ts`:
```ts
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
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run src/main/skills-runtime/marketplace/__tests__/installer.test.ts`
Expected: PASS(4 个用例)。

- [ ] **Step 5: Commit**

```bash
git add src/main/skills-runtime/marketplace/installer.ts \
  src/main/skills-runtime/marketplace/__tests__/installer.test.ts
git commit -m "feat(skills-market): installer 支持 git/url 安装与回滚 + 卸载"
```

---

## Task 3: skill_trust SQLite 表 + CRUD

**Files:**
- Modify: `src/main/db/index.ts`(建表 SQL + CRUD 函数)
- Test: `src/main/db/__tests__/skill-trust.test.ts`

> 仿现有 `mcp_servers` 的建表与 CRUD 风格(`src/main/db/index.ts` 中 `CREATE TABLE IF NOT EXISTS mcp_servers` 块与 `createMcpServer`)。数据库句柄变量名为 `sqlite`(mcp 迁移段用 `sqlite.prepare(...)` 已确认)。

- [ ] **Step 1: 写失败测试**

`src/main/db/__tests__/skill-trust.test.ts`:
```ts
import { beforeEach, describe, expect, it } from "vitest";
import {
  deleteSkillTrust,
  getSkillTrust,
  upsertSkillTrust,
  type SkillTrustRow,
} from "../index";

const rec: SkillTrustRow = {
  skillId: "pdf-tools",
  sourcePath: "/tmp/pdf-tools/SKILL.md",
  contentHash: "abc123",
  approved: true,
  approvedAt: "2026-06-04T00:00:00.000Z",
  allowCommands: true,
  allowHooks: false,
};

beforeEach(() => {
  deleteSkillTrust("pdf-tools");
});

describe("skill_trust CRUD", () => {
  it("upserts and reads back a record", () => {
    upsertSkillTrust(rec);
    expect(getSkillTrust("pdf-tools")).toEqual(rec);
  });

  it("updates an existing record on second upsert", () => {
    upsertSkillTrust(rec);
    upsertSkillTrust({ ...rec, contentHash: "def456", approved: false });
    const got = getSkillTrust("pdf-tools");
    expect(got?.contentHash).toBe("def456");
    expect(got?.approved).toBe(false);
  });

  it("returns null for unknown skill", () => {
    expect(getSkillTrust("nope")).toBeNull();
  });

  it("deletes a record", () => {
    upsertSkillTrust(rec);
    deleteSkillTrust("pdf-tools");
    expect(getSkillTrust("pdf-tools")).toBeNull();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run src/main/db/__tests__/skill-trust.test.ts`
Expected: FAIL — 导出不存在。

- [ ] **Step 3: 加建表 SQL**

在 `src/main/db/index.ts` 的建表 `exec(...)` 块里(紧随 `mcp_servers` 之后)加:
```sql
    CREATE TABLE IF NOT EXISTS skill_trust (
      skill_id TEXT PRIMARY KEY,
      source_path TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      approved INTEGER NOT NULL DEFAULT 0,
      approved_at TEXT,
      allow_commands INTEGER NOT NULL DEFAULT 0,
      allow_hooks INTEGER NOT NULL DEFAULT 0
    );
```

- [ ] **Step 4: 加类型与 CRUD 实现**

在 `src/main/db/index.ts` 末尾(MCP 相关函数附近)加:
```ts
// 技能信任(市场安装 / 外部 skill 审批的持久化)
export interface SkillTrustRow {
  skillId: string;
  sourcePath: string;
  contentHash: string;
  approved: boolean;
  approvedAt: string | null;
  allowCommands: boolean;
  allowHooks: boolean;
}

interface SkillTrustDbRow {
  skill_id: string;
  source_path: string;
  content_hash: string;
  approved: number;
  approved_at: string | null;
  allow_commands: number;
  allow_hooks: number;
}

const mapSkillTrustRow = (r: SkillTrustDbRow): SkillTrustRow => ({
  skillId: r.skill_id,
  sourcePath: r.source_path,
  contentHash: r.content_hash,
  approved: r.approved === 1,
  approvedAt: r.approved_at,
  allowCommands: r.allow_commands === 1,
  allowHooks: r.allow_hooks === 1,
});

export const getSkillTrust = (skillId: string): SkillTrustRow | null => {
  const row = sqlite
    .prepare("SELECT * FROM skill_trust WHERE skill_id = ?")
    .get(skillId) as SkillTrustDbRow | undefined;
  return row ? mapSkillTrustRow(row) : null;
};

export const upsertSkillTrust = (rec: SkillTrustRow): void => {
  sqlite
    .prepare(
      `INSERT INTO skill_trust
         (skill_id, source_path, content_hash, approved, approved_at, allow_commands, allow_hooks)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(skill_id) DO UPDATE SET
         source_path = excluded.source_path,
         content_hash = excluded.content_hash,
         approved = excluded.approved,
         approved_at = excluded.approved_at,
         allow_commands = excluded.allow_commands,
         allow_hooks = excluded.allow_hooks`,
    )
    .run(
      rec.skillId,
      rec.sourcePath,
      rec.contentHash,
      rec.approved ? 1 : 0,
      rec.approvedAt,
      rec.allowCommands ? 1 : 0,
      rec.allowHooks ? 1 : 0,
    );
};

export const deleteSkillTrust = (skillId: string): void => {
  sqlite.prepare("DELETE FROM skill_trust WHERE skill_id = ?").run(skillId);
};

/** 仅测试用:清空信任表。 @internal */
export const _deleteAllSkillTrust = (): void => {
  sqlite.prepare("DELETE FROM skill_trust").run();
};
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm vitest run src/main/db/__tests__/skill-trust.test.ts`
Expected: PASS(4 个用例)。

- [ ] **Step 6: Commit**

```bash
git add src/main/db/index.ts src/main/db/__tests__/skill-trust.test.ts
git commit -m "feat(db): skill_trust 表 + CRUD(信任持久化)"
```

---

## Task 4: security.ts 信任读写改为走 DB

**Files:**
- Modify: `src/main/skills-runtime/security.ts`

> 把内存 `trustStore` 换成 DB CRUD,保持 `isSkillTrusted` / `requestSkillApproval` / `_clearTrustStore` / `_setTrustRecord` 的对外签名不变,使现有测试与调用方无需改动。

- [ ] **Step 1: 跑现有 security 测试建立回归基线**

Run: `pnpm vitest run src/main/skills-runtime/__tests__`
记录当前通过的信任相关用例,作为重构后必须仍通过的基线。若有用例断言「重启/清空后失信」,确认它通过 `_clearTrustStore` 实现,重构后仍成立。

- [ ] **Step 2: 顶部 import DB CRUD,删除内存 store**

在 `src/main/skills-runtime/security.ts`:删除 `const trustStore = new Map<string, SkillTrustRecord>();`,并在 import 区加:
```ts
import {
  _deleteAllSkillTrust,
  getSkillTrust,
  upsertSkillTrust,
  type SkillTrustRow,
} from "../db";
```

- [ ] **Step 3: 改 `isSkillTrusted` 走 DB**

```ts
export function isSkillTrusted(skillId: string, currentHash: string): boolean {
  const row = getSkillTrust(skillId);
  if (!row) return false;
  return row.approved && row.contentHash === currentHash;
}
```

- [ ] **Step 4: 改 `requestSkillApproval` 落库**

把函数末尾 `trustStore.set(skillId, record); return record;` 替换为:
```ts
  const row: SkillTrustRow = {
    skillId,
    sourcePath: skill.sourcePath,
    contentHash,
    approved: true,
    approvedAt: new Date().toISOString(),
    allowCommands: commands.length > 0,
    allowHooks: hooks.length > 0,
  };
  upsertSkillTrust(row);

  return {
    skillId: row.skillId,
    sourcePath: row.sourcePath,
    contentHash: row.contentHash,
    approved: row.approved,
    approvedAt: row.approvedAt ?? undefined,
    permissions: {
      allowCommands: row.allowCommands,
      allowHooks: row.allowHooks,
    },
  };
```

- [ ] **Step 5: 改测试辅助函数走 DB**

```ts
export function _clearTrustStore(): void {
  _deleteAllSkillTrust();
}

export function _setTrustRecord(
  skillId: string,
  record: SkillTrustRecord,
): void {
  upsertSkillTrust({
    skillId,
    sourcePath: record.sourcePath,
    contentHash: record.contentHash,
    approved: record.approved,
    approvedAt: record.approvedAt ?? null,
    allowCommands: record.permissions.allowCommands,
    allowHooks: record.permissions.allowHooks,
  });
}
```

- [ ] **Step 6: 运行 security 相关测试确认仍通过**

Run: `pnpm vitest run src/main/skills-runtime/__tests__`
Expected: PASS。

- [ ] **Step 7: Commit**

```bash
git add src/main/skills-runtime/security.ts
git commit -m "refactor(skills): 信任存储从内存 Map 迁移到 skill_trust 表"
```

---

## Task 5: marketplace 编排 index.ts + registry 刷新 personal

**Files:**
- Create: `src/main/skills-runtime/marketplace/index.ts`
- Modify: `src/main/skills-runtime/registry.ts`(加 `refreshPersonalSkills`)
- Modify: `src/main/skills-runtime/index.ts`(导出 marketplace API)
- Test: `src/main/skills-runtime/marketplace/__tests__/index.test.ts`

- [ ] **Step 1: 给 SkillRegistry 加 refreshPersonalSkills**

在 `src/main/skills-runtime/registry.ts` 的 `refreshProjectSkills` 之后加:
```ts
  /**
   * 刷新 personal 级别技能(~/.agents/skills)。
   * 市场安装 / 卸载后调用,使新装的技能被发现。personal 源
   * 不依赖工作区路径,故 buildDiscoverySources 传空串即可。
   */
  async refreshPersonalSkills(
    enabledSkillIds?: Iterable<string>,
  ): Promise<void> {
    for (const [id, skill] of this.skills) {
      if (skill.external?.source.type === "personal") this.skills.delete(id);
    }
    for (const [id, d] of this.allDiscovered) {
      if (d.source.type === "personal") this.allDiscovered.delete(id);
    }
    const sources = buildDiscoverySources("");
    const personalSources = sources.filter((s) => s.type === "personal");
    const discovered = await discoverSkills(personalSources);
    this.registerExternal(
      discovered,
      enabledSkillIds ? { enabledSkillIds } : undefined,
    );
  }
```

- [ ] **Step 2: 写失败测试(编排层 list)**

`src/main/skills-runtime/marketplace/__tests__/index.test.ts`:
```ts
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listMarket } from "../index";
import type { MarketEntry } from "../types";

const entry: MarketEntry = {
  id: "pdf-tools",
  name: "PDF Tools",
  description: "d",
  level: "official",
  source: { type: "url", url: "https://example.com/SKILL.md" },
};

let skillsRoot: string;
beforeEach(() => {
  skillsRoot = mkdtempSync(join(tmpdir(), "fw-mkt-"));
});
afterEach(() => rmSync(skillsRoot, { recursive: true, force: true }));

describe("listMarket", () => {
  it("flags entries already present in skillsRoot as installed", async () => {
    mkdirSync(join(skillsRoot, "pdf-tools"), { recursive: true });
    writeFileSync(join(skillsRoot, "pdf-tools", "SKILL.md"), "x");
    const fetchRegistry = vi.fn().mockResolvedValue([entry]);
    const out = await listMarket({ skillsRoot, fetchRegistry });
    expect(out).toHaveLength(1);
    expect(out[0].installed).toBe(true);
  });

  it("flags absent entries as not installed", async () => {
    const fetchRegistry = vi.fn().mockResolvedValue([entry]);
    const out = await listMarket({ skillsRoot, fetchRegistry });
    expect(out[0].installed).toBe(false);
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `pnpm vitest run src/main/skills-runtime/marketplace/__tests__/index.test.ts`
Expected: FAIL — `listMarket` 未定义。

- [ ] **Step 4: 写编排实现**

`src/main/skills-runtime/marketplace/index.ts`:
```ts
/**
 * 市场编排层。
 *
 * list:拉 registry + 标记本地已装状态。
 * install:安装文件 + 计算内容哈希 + 落信任记录(已批准)+ 返回结果。
 * uninstall:删目录 + 删信任记录。
 * 触发重扫与启用由 IPC 层负责(它持有 skillRegistry 与设置)。
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { deleteSkillTrust, upsertSkillTrust } from "../../db";
import { computeSkillHash } from "../security";
import { DEFAULT_SKILLS_ROOT, installEntry, uninstallSkill } from "./installer";
import { fetchRegistry as defaultFetchRegistry } from "./registry-client";
import type {
  InstallResult,
  MarketEntry,
  MarketEntryWithStatus,
} from "./types";

interface ListOpts {
  skillsRoot?: string;
  fetchRegistry?: () => Promise<MarketEntry[]>;
}

/** 拉取市场清单并标注本地安装状态。 */
export async function listMarket(
  opts: ListOpts = {},
): Promise<MarketEntryWithStatus[]> {
  const skillsRoot = opts.skillsRoot ?? DEFAULT_SKILLS_ROOT;
  const fetchReg = opts.fetchRegistry ?? (() => defaultFetchRegistry());
  const entries = await fetchReg();
  return entries.map((e) => ({
    ...e,
    installed: existsSync(join(skillsRoot, e.id, "SKILL.md")),
  }));
}

interface MutateOpts {
  skillsRoot?: string;
}

/**
 * 安装一条市场条目并写入已批准的信任记录。
 * 调用方(IPC 层)负责在成功后触发重扫与启用。
 */
export async function installMarketSkill(
  entry: MarketEntry,
  opts: MutateOpts = {},
): Promise<InstallResult> {
  const skillsRoot = opts.skillsRoot ?? DEFAULT_SKILLS_ROOT;
  const res = await installEntry(entry, { skillsRoot });
  if (!res.ok || !res.installedPath) return res;

  const skillDir = join(skillsRoot, entry.id);
  let contentHash = "";
  try {
    contentHash = await computeSkillHash(skillDir);
  } catch {
    contentHash = "";
  }
  upsertSkillTrust({
    skillId: entry.id,
    sourcePath: join(skillDir, "SKILL.md"),
    contentHash,
    approved: true,
    approvedAt: new Date().toISOString(),
    allowCommands: true,
    allowHooks: true,
  });
  return res;
}

/** 卸载一条市场 skill 并删除其信任记录。 */
export async function uninstallMarketSkill(
  skillId: string,
  opts: MutateOpts = {},
): Promise<void> {
  await uninstallSkill(skillId, { skillsRoot: opts.skillsRoot });
  deleteSkillTrust(skillId);
}
```

> 信任记录的 `allowCommands/allowHooks` MVP 默认 true(安装即整体批准);细粒度勾选留 v2。

- [ ] **Step 5: 导出 marketplace API**

在 `src/main/skills-runtime/index.ts` 末尾加:
```ts
export {
  installMarketSkill,
  listMarket,
  uninstallMarketSkill,
} from "./marketplace";
export type {
  InstallResult,
  MarketEntry,
  MarketEntryWithStatus,
} from "./marketplace/types";
```

- [ ] **Step 6: 运行测试确认通过**

Run: `pnpm vitest run src/main/skills-runtime/marketplace/__tests__/index.test.ts`
Expected: PASS(2 个用例)。

- [ ] **Step 7: Commit**

```bash
git add src/main/skills-runtime/marketplace/index.ts \
  src/main/skills-runtime/marketplace/__tests__/index.test.ts \
  src/main/skills-runtime/registry.ts src/main/skills-runtime/index.ts
git commit -m "feat(skills-market): 编排层 list/install/uninstall + refreshPersonalSkills"
```

---

## Task 6: IPC 通道 + preload 桥

**Files:**
- Modify: `src/main/ipc/ai-handlers.ts`(3 个 `market:*` 通道)
- Modify: `src/preload/index.ts`(暴露 3 个方法)

- [ ] **Step 1: 加 IPC handler**

在 `src/main/ipc/ai-handlers.ts` 顶部 import 处加(`skillRegistry`、`setSetting` 已 import):
```ts
import {
  installMarketSkill,
  listMarket,
  uninstallMarketSkill,
  type MarketEntry,
} from "../skills-runtime";
```
在 `registerAiHandlers` 内(`ai:setSkillEnabled` 同块)加:
```ts
  ipcMain.handle("market:list", async () => {
    try {
      return { ok: true, entries: await listMarket() };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      console.error("[market:list] Failed:", msg);
      return { ok: false, error: msg, entries: [] };
    }
  });

  ipcMain.handle(
    "market:install",
    async (_event, payload: { entry: MarketEntry }) => {
      try {
        const res = await installMarketSkill(payload.entry);
        if (!res.ok) return res;
        // 重扫 personal 源并自动启用新装的 skill
        const ids = new Set(skillRegistry.getEnabledSkillIds());
        ids.add(payload.entry.id);
        await skillRegistry.refreshPersonalSkills(ids);
        skillRegistry.setSkillEnabled(payload.entry.id, true);
        setSetting(
          "skills.enabled-ids",
          JSON.stringify(skillRegistry.getEnabledSkillIds()),
        );
        return res;
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : "Unknown error";
        console.error("[market:install] Failed:", msg);
        return { ok: false, skillId: payload.entry.id, error: msg };
      }
    },
  );

  ipcMain.handle(
    "market:uninstall",
    async (_event, payload: { skillId: string }) => {
      try {
        await uninstallMarketSkill(payload.skillId);
        const ids = skillRegistry
          .getEnabledSkillIds()
          .filter((id) => id !== payload.skillId);
        await skillRegistry.refreshPersonalSkills(new Set(ids));
        setSetting("skills.enabled-ids", JSON.stringify(ids));
        return { ok: true };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : "Unknown error";
        console.error("[market:uninstall] Failed:", msg);
        return { ok: false, error: msg };
      }
    },
  );
```

- [ ] **Step 2: 暴露 preload 方法**

在 `src/preload/index.ts` 的 `refreshSkills` 附近加:
```ts
  marketList: () => ipcRenderer.invoke("market:list"),
  marketInstall: (entry: unknown) =>
    ipcRenderer.invoke("market:install", { entry }),
  marketUninstall: (skillId: string) =>
    ipcRenderer.invoke("market:uninstall", { skillId }),
```
若该文件(或其 `.d.ts`)维护了 `window.filework` 的类型声明,补上对应签名(返回 `Promise<unknown>` 即可,渲染侧已就地 as 断言)。

- [ ] **Step 3: 类型检查**

Run: `pnpm typecheck`
Expected: 无新增类型错误。

- [ ] **Step 4: Commit**

```bash
git add src/main/ipc/ai-handlers.ts src/preload/index.ts
git commit -m "feat(skills-market): market:list/install/uninstall IPC + preload 桥"
```

---

## Task 7: SkillsModal「市场」tab + 安装确认 + i18n

**Files:**
- Modify: `src/renderer/components/skills/SkillsModal.tsx`
- Modify: `src/renderer/i18n/`(已有 locale 文件,如 `en/index.ts` 与中文 locale)

> 市场渲染直接放在 `SkillsModal` 主体(而非 `SkillListView` 内),保持本地列表组件职责不变;市场 tab 切换时数据源从 `window.filework.marketList()` 取。

- [ ] **Step 1: 加 i18n 文案键**

在每个 locale 的 skills 文案附近加(键名一致,值按语言翻译):
```ts
  skillsModal_market: "市场",
  skillsModal_marketInstall: "安装",
  skillsModal_marketInstalled: "已安装",
  skillsModal_marketUninstall: "卸载",
  skillsModal_marketCommunity: "社区",
  skillsModal_marketOfficial: "官方",
  skillsModal_marketInstalling: "安装中…",
  skillsModal_marketConfirmCommunity:
    "这是社区贡献的技能,安装后可在你的工作区中执行命令与脚本。仅在信任来源时安装。",
  skillsModal_marketEmpty: "市场暂无可用技能",
  skillsModal_marketError: "加载市场失败",
```
若项目要求生成 i18n 类型:`pnpm typesafe-i18n`。

- [ ] **Step 2: 在 SkillsModal 加市场类型、状态与数据加载**

`SkillsModal.tsx` 顶部类型区加:
```ts
interface MarketItem {
  id: string;
  name: string;
  description: string;
  level: "official" | "community";
  installed: boolean;
  source: unknown;
}
```
组件内加状态(放在现有 useState 群附近):
```ts
const [market, setMarket] = useState<MarketItem[]>([]);
const [marketLoading, setMarketLoading] = useState(false);
const [marketError, setMarketError] = useState<string | null>(null);
const [installingId, setInstallingId] = useState<string | null>(null);
const isMarket = filter === ("market" as FilterType);
```
切到市场 tab 时加载:
```ts
useEffect(() => {
  if (!open || !isMarket) return;
  let cancelled = false;
  setMarketLoading(true);
  setMarketError(null);
  void (async () => {
    const res = (await window.filework.marketList()) as {
      ok: boolean;
      error?: string;
      entries: MarketItem[];
    };
    if (cancelled) return;
    if (res.ok) setMarket(res.entries);
    else setMarketError(res.error ?? "error");
    setMarketLoading(false);
  })();
  return () => {
    cancelled = true;
  };
}, [open, isMarket]);
```

- [ ] **Step 3: 加安装/卸载处理**

组件内加(复用现有 `refreshSkills`):
```ts
const handleInstall = useCallback(
  async (item: MarketItem) => {
    if (item.level === "community") {
      if (!window.confirm(LL.skillsModal_marketConfirmCommunity())) return;
    }
    setInstallingId(item.id);
    const res = (await window.filework.marketInstall(item)) as {
      ok: boolean;
      error?: string;
    };
    setInstallingId(null);
    if (res.ok) {
      setMarket((prev) =>
        prev.map((m) => (m.id === item.id ? { ...m, installed: true } : m)),
      );
      await refreshSkills();
    } else {
      console.warn("[market] install failed:", res.error);
    }
  },
  [LL, refreshSkills],
);

const handleUninstall = useCallback(
  async (skillId: string) => {
    const res = (await window.filework.marketUninstall(skillId)) as {
      ok: boolean;
    };
    if (res.ok) {
      setMarket((prev) =>
        prev.map((m) => (m.id === skillId ? { ...m, installed: false } : m)),
      );
      await refreshSkills();
    }
  },
  [refreshSkills],
);
```
> 现有 `refreshSkills` 当前签名为 `refreshSkills(workspacePath)` 经由 `window.filework.refreshSkills`,而组件内的 `refreshSkills`(useCallback)调用 `listAllSkills`。沿用组件内已有的 `refreshSkills`(它重拉本地列表),无需 workspacePath。

- [ ] **Step 4: 加「市场」FilterTab**

在 `SkillListView` 的 tabs 渲染处(`availableSources.map(...)` 之后)加固定 tab。由于 `SkillListView` 已接收 `filter`/`onFilterChange`,直接加:
```tsx
<FilterTab
  active={filter === ("market" as FilterType)}
  onClick={() => onFilterChange("market" as FilterType)}
>
  {LL.skillsModal_market()}
</FilterTab>
```

- [ ] **Step 5: 主体按 isMarket 分支渲染市场列表**

在 `SkillsModal` 主体里,把当前 `selectedSkillId ? <SkillDetailView/> : <SkillListView/>` 的三元改为:市场 tab 且未选中详情时渲染市场视图。最小改法 —— 在 `<SkillListView .../>` 外层包一层:
```tsx
{selectedSkillId ? (
  <SkillDetailView detail={detail} loading={loading} onToggle={handleSkillToggle} />
) : isMarket ? (
  <MarketView
    items={market}
    loading={marketLoading}
    error={marketError}
    search={search}
    onSearchChange={setSearch}
    filter={filter}
    onFilterChange={setFilter}
    availableSources={availableSources}
    installingId={installingId}
    onInstall={handleInstall}
    onUninstall={handleUninstall}
  />
) : (
  <SkillListView
    skills={filtered}
    filter={filter}
    onFilterChange={setFilter}
    search={search}
    onSearchChange={setSearch}
    availableSources={availableSources}
    onSelect={setSelectedSkillId}
    onSkillToggle={handleSkillToggle}
  />
)}
```
新增 `MarketView` 组件(放在文件内 `SkillListView` 附近),复用搜索框 + tabs 骨架:
```tsx
const MarketView = ({
  items,
  loading,
  error,
  search,
  onSearchChange,
  filter,
  onFilterChange,
  availableSources,
  installingId,
  onInstall,
  onUninstall,
}: {
  items: MarketItem[];
  loading: boolean;
  error: string | null;
  search: string;
  onSearchChange: (s: string) => void;
  filter: FilterType;
  onFilterChange: (f: FilterType) => void;
  availableSources: SourceType[];
  installingId: string | null;
  onInstall: (item: MarketItem) => void | Promise<void>;
  onUninstall: (skillId: string) => void | Promise<void>;
}) => {
  const { LL } = useI18nContext();
  const sourceLabels = useMemo(() => getSourceLabels(LL), [LL]);
  const shown = items.filter((m) =>
    !search
      ? true
      : (m.name + m.description).toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <>
      <div className="px-6 pt-4 pb-2 space-y-3 shrink-0">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <input
            type="text"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder={LL.skillsModal_search()}
            className="w-full pl-9 pr-3 py-2 text-sm rounded-lg border border-border bg-muted/30 text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
        <div className="flex gap-1.5 flex-wrap">
          <FilterTab active={false} onClick={() => onFilterChange("all")}>
            {sourceLabels["built-in"] /* 占位:回到本地视图用现有标签 */}
          </FilterTab>
          {availableSources.map((src) => (
            <FilterTab key={src} active={false} onClick={() => onFilterChange(src)}>
              {sourceLabels[src]}
            </FilterTab>
          ))}
          <FilterTab active={true} onClick={() => onFilterChange("market" as FilterType)}>
            {LL.skillsModal_market()}
          </FilterTab>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-6 pb-4">
        {loading ? (
          <div className="py-12 text-center text-sm text-muted-foreground">
            {LL.skillsModal_loading()}
          </div>
        ) : error ? (
          <div className="py-12 text-center text-sm text-red-500">
            {LL.skillsModal_marketError()}
          </div>
        ) : shown.length === 0 ? (
          <div className="py-12 text-center text-sm text-muted-foreground">
            {LL.skillsModal_marketEmpty()}
          </div>
        ) : (
          <div className="space-y-2 pt-1">
            {shown.map((m) => (
              <div key={m.id} className="relative rounded-lg border border-border p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      <span className="font-medium text-sm text-foreground truncate">
                        {m.name}
                      </span>
                      <span
                        className={cn(
                          "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium",
                          m.level === "community"
                            ? "bg-amber-500/10 text-amber-600"
                            : "bg-blue-500/10 text-blue-500",
                        )}
                      >
                        {m.level === "community"
                          ? LL.skillsModal_marketCommunity()
                          : LL.skillsModal_marketOfficial()}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground line-clamp-2">
                      {m.description}
                    </p>
                  </div>
                  {m.installed ? (
                    <button
                      type="button"
                      onClick={() => onUninstall(m.id)}
                      className="shrink-0 text-xs px-2 py-1 rounded-md border border-border text-muted-foreground hover:bg-accent"
                    >
                      {LL.skillsModal_marketUninstall()}
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={installingId === m.id}
                      onClick={() => onInstall(m)}
                      className="shrink-0 text-xs px-2 py-1 rounded-md border border-primary bg-primary/10 text-primary disabled:opacity-50"
                    >
                      {installingId === m.id
                        ? LL.skillsModal_marketInstalling()
                        : LL.skillsModal_marketInstall()}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
};
```
> 注:`MarketView` 内 tabs 的非市场项点击会切回本地 filter,从而离开市场视图(`isMarket` 变 false),渲染自动切回 `SkillListView`。`FilterTab active={false}` 第一个 tab 的标签用现成键即可,无需新增;若想显示「全部」,复用 `LL.skillsModal_all(...)`。

- [ ] **Step 6: 类型检查 + 手动验证**

Run: `pnpm typecheck`
Expected: 无错误。

Run: `pnpm dev`
- 打开 Skills 弹窗 → 点「市场」tab → 显示条目(registry 不可达时显示「加载市场失败」)。
- 安装 official 条目 → 按钮变「已安装」→ 切回本地 tab 能看到该 skill。
- 卸载 → 目录被删,本地列表消失。
- community 条目点安装 → 弹确认框。

- [ ] **Step 7: Commit**

```bash
git add src/renderer/components/skills/SkillsModal.tsx src/renderer/i18n
git commit -m "feat(skills-market): SkillsModal 市场 tab + 安装/卸载 + 社区确认 + i18n"
```

---

## Task 8: 收尾验证

- [ ] **Step 1: 全量测试**

Run: `pnpm vitest run src/main/skills-runtime src/main/db`
Expected: 全绿。

- [ ] **Step 2: 类型检查 + lint**

Run: `pnpm typecheck && pnpm lint`
Expected: 无错误。

- [ ] **Step 3: 准备一份真实 registry.json**

把 `MARKETPLACE_REGISTRY_URL` 指向你实际托管的 raw URL,registry.json 形如:
```json
{
  "entries": [
    {
      "id": "example-skill",
      "name": "Example",
      "description": "示例技能",
      "level": "official",
      "source": { "type": "git", "repo": "https://github.com/you/skills", "subdir": "example-skill" }
    }
  ]
}
```

- [ ] **Step 4: 端到端冒烟**

`pnpm dev` → 市场 tab 拉到真实清单 → 安装 → 在对话中 `/example-skill` 可调用。

- [ ] **Step 5: Commit(如有收尾改动)**

```bash
git add -A && git commit -m "chore(skills-market): 收尾验证与 registry 地址"
```

---

## 自查

**Spec 覆盖**
- 数据源(自托管 registry.json)→ Task 1 ✅
- git 子目录 + 单文件 URL 安装到 ~/.agents/skills → Task 2 ✅
- registry schema 向 .well-known 约定对齐 → Task 1 MarketEntry ✅
- 信任安装时审批 + 持久化 SQLite → Task 3 + 4 + 5 ✅
- community 起始信任更低(警示) → Task 7 确认弹窗 ✅(MVP 以「安装即审批 + 文案警示」体现;细粒度起始信任降级留 v2)
- SkillsModal 市场 tab → Task 7 ✅
- 3 个 IPC 通道 + preload → Task 6 ✅
- 复用现有 discovery 重扫 → Task 5 refreshPersonalSkills + Task 6 调用 ✅
- 测试(registry-client/installer/信任落库) → Task 1/2/3 ✅
- 不做:MCP 市场 / 扫描器 / 版本升级 / 多源聚合 / 评分 → 未出现在任务中 ✅

**Placeholder 扫描**:每个代码步骤含完整代码;无 TBD/TODO。

**类型一致性**:`MarketEntry`/`MarketEntryWithStatus`/`InstallResult`(Task 1)→ installer(Task 2)→ index(Task 5)→ IPC(Task 6)→ UI(Task 7)贯穿一致;`SkillTrustRow`(Task 3)在 Task 4/5 一致使用;`installEntry`/`uninstallSkill`/`installMarketSkill`/`uninstallMarketSkill`/`listMarket`/`fetchRegistry`/`validateEntry`/`clearRegistryCache`/`refreshPersonalSkills` 命名前后一致。
