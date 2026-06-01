/**
 * 工作目录级记忆（per-workspace memory）—— 仓库零足迹 + 结构化条目版。
 *
 * 设计原则(对标 Claude Code / ChatGPT 的做法):
 *  - 人写指令与机器记忆分离:读时合并「人写 AGENTS.md / CLAUDE.md(只读)」+「机器记忆」。
 *  - 机器记忆是「可寻址的离散条目」,不是往文本末尾追加:每条带稳定主键 key,
 *    同一事实复用同一 key → upsert 覆盖,而非换个措辞就新增一条(根治重复)。
 *  - 作用域分离:`user` 偏好(回复语言/语气等)跨所有工作区只存一份;`workspace`
 *    事实(构建命令/目录结构/约定)按工作目录哈希独立存放。
 *  - 零 git 噪声:全部落到应用数据目录 ~/.filework,绝不写进用户仓库。
 *  - 迁移:① 历史 <!-- filework:memory --> 托管块迁出 AGENTS.md;② 旧版纯文本
 *    `<key>.md` 首次读取时解析成条目并去重,随后删除旧文件。
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { workspaceKey } from "../session/workspace-key";
import type { Workspace } from "./types";

/** 人写的指令文件(只读注入,按顺序取首个存在者)。 */
const HUMAN_INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md"] as const;

/** 注入上限(字符,约 8KB),避免超大内容挤占上下文预算。 */
const MAX_MEMORY_CHARS = 8 * 1024;

/** 历史遗留的托管块标记 —— 仅用于一次性迁移。 */
const LEGACY_BLOCK_START = "<!-- filework:memory:start -->";
const LEGACY_BLOCK_END = "<!-- filework:memory:end -->";
const LEGACY_HEADING = "## Workspace Memory (auto-maintained by the agent)";

/** 记忆作用域:user 跨所有工作区共享;workspace 仅当前项目。 */
export type MemoryScope = "user" | "workspace";

/** 记忆分类(决定渲染顺序与归类)。 */
export type MemoryCategory =
  | "preference"
  | "project"
  | "convention"
  | "reference";

/** 一条结构化记忆。key 是语义主键,同一事实复用同一 key 即覆盖。 */
export interface MemoryEntry {
  key: string;
  category: MemoryCategory;
  text: string;
  updatedAt: string;
}

/** 分类渲染顺序(偏好在前,参考在后)。 */
const CATEGORY_ORDER: MemoryCategory[] = [
  "preference",
  "convention",
  "project",
  "reference",
];

/**
 * 机器记忆根目录,默认 ~/.filework/workspace-memory。
 * 测试可用 {@link setWorkspaceMemoryRoot} 覆盖,避免污染真实用户数据。
 * user 记忆落在同目录下的保留文件 `_user.json`(工作区文件名是 16 位 hex,不冲突)。
 */
let memoryRoot = path.join(homedir(), ".filework", "workspace-memory");

/** 覆盖机器记忆根目录(bootstrap / 测试用)。 */
export function setWorkspaceMemoryRoot(dir: string): void {
  memoryRoot = dir;
}

/**
 * 按文件路径串行化「读-改-写」,避免同回合内并行的 remember/forget/clear
 * 互相覆盖(后写吃掉前写)。每个 path 维护一条 promise 链,空闲后清理。
 */
const fileLocks = new Map<string, Promise<unknown>>();
function withFileLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = fileLocks.get(key) ?? Promise.resolve();
  // 无论 prev 成功失败,都在其结算后再跑 fn → 严格串行。
  const run = prev.then(fn, fn);
  const tail: Promise<void> = run.then(
    () => {
      if (fileLocks.get(key) === tail) fileLocks.delete(key);
    },
    () => {
      if (fileLocks.get(key) === tail) fileLocks.delete(key);
    },
  );
  fileLocks.set(key, tail);
  return run;
}

/**
 * 敏感信息检测:命中则拒绝写入记忆(避免把密钥/令牌持久化并注入每轮提示)。
 * 高信号特征 + 通用「<敏感词>=<值>」赋值式。
 */
const SECRET_PATTERNS: RegExp[] = [
  /sk-[a-z0-9]{16,}/i, // OpenAI / Anthropic 风格
  /\bgh[oprsu]_[A-Za-z0-9]{20,}/, // GitHub token
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /\bAIza[0-9A-Za-z\-_]{35}\b/, // Google API key
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/, // Slack
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, // 私钥
  /\b(?:api[_-]?key|secret|passwd|password|token)\b\s*[:=]\s*\S{8,}/i, // 赋值式
];

/** 文本是否疑似含敏感凭据。 */
export function containsSecret(text: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(text));
}

/** rememberMemory 因命中敏感信息而拒绝写入时抛出。 */
export class MemorySecretError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemorySecretError";
  }
}

/** 把 `readFile` 的返回（string | Uint8Array）统一为字符串。 */
function toText(content: string | Uint8Array): string {
  return typeof content === "string"
    ? content
    : new TextDecoder("utf-8").decode(content);
}

/** 转义正则元字符。 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 匹配整段历史托管块(连同其前后相邻的空行),便于整段移除而不影响其它内容。 */
function legacyBlockRegex(): RegExp {
  return new RegExp(
    `\\n*${escapeRegExp(LEGACY_BLOCK_START)}[\\s\\S]*?${escapeRegExp(LEGACY_BLOCK_END)}\\n*`,
  );
}

/** 工作区结构化记忆文件路径(JSON)。 */
function workspaceEntriesPath(workspaceRoot: string): string {
  return path.join(memoryRoot, `${workspaceKey(workspaceRoot)}.json`);
}

/** 旧版纯文本记忆文件路径(.md)—— 仅用于一次性迁移。 */
function legacyMdPath(workspaceRoot: string): string {
  return path.join(memoryRoot, `${workspaceKey(workspaceRoot)}.md`);
}

/** user 作用域记忆文件路径(跨工作区共享)。 */
function userEntriesPath(): string {
  return path.join(memoryRoot, "_user.json");
}

/** 把任意字符串规整成稳定的 kebab-case 主键。 */
function slugifyKey(raw: string): string {
  const s = raw
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    // 保留 a-z0-9- 与 CJK,其余丢弃
    .replace(/[^a-z0-9一-鿿-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return s || `note-${randomUUID().slice(0, 8)}`;
}

/** 读结构化条目(不存在 / 解析失败返回空数组)。 */
async function readEntries(filePath: string): Promise<MemoryEntry[]> {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf-8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is MemoryEntry =>
        e && typeof e.key === "string" && typeof e.text === "string",
    );
  } catch {
    return [];
  }
}

/** 原子写结构化条目(先写临时文件再 rename,避免半写)。 */
async function writeEntries(
  filePath: string,
  entries: MemoryEntry[],
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(entries, null, 2)}\n`, "utf-8");
  await rename(tmp, filePath);
}

/** 归一化文本用于近重复判断:去空白 / 标点 / emoji,仅留字母数字与 CJK。 */
function normalizeForCompare(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9一-鿿]/g, "");
}

/**
 * 近重复:仅在「归一化后完全相等」时判重(只差大小写 / 标点 / 空白 / emoji)。
 * 不做模糊相似度(bigram / 子串包含)—— 那会把同分类下两条「确实不同」的事实
 * 静默并成一条而无任何提示。模糊重复交由「复用同一 key」这一主机制处理。
 */
function isNearDuplicate(a: string, b: string): boolean {
  const na = normalizeForCompare(a);
  const nb = normalizeForCompare(b);
  return na.length > 0 && na === nb;
}

/**
 * upsert 一条记忆:
 *  - key 命中 → 覆盖那条;
 *  - 否则同 category 下若有「归一化完全相同」的旧条目 → 覆盖它(防换 key 重复);
 *  - 都没有 → 追加。
 */
function upsertEntry(entries: MemoryEntry[], next: MemoryEntry): MemoryEntry[] {
  const byKey = entries.findIndex((e) => e.key === next.key);
  if (byKey >= 0) {
    entries[byKey] = next;
    return entries;
  }
  const dup = entries.findIndex(
    (e) => e.category === next.category && isNearDuplicate(e.text, next.text),
  );
  if (dup >= 0) {
    entries[dup] = next;
    return entries;
  }
  entries.push(next);
  return entries;
}

/**
 * 把旧版纯文本(无结构的 markdown)收成「一条」隔离条目。
 *
 * 旧格式没有 key/scope/category 信息,逐行机械拆分只会造出一堆语义垃圾 key、
 * 把个人偏好误标成项目事实、还复刻历史重复。所以不假装它是 N 条精挑的事实,
 * 而是整体收进单条 `legacy-notes`(category=reference),明确标记为「导入的旧
 * 笔记,待重新归类」—— 模型读到后可按需 forget 或拆成规范条目。
 */
function legacyEntriesFrom(text: string): MemoryEntry[] {
  const lines = text
    .split("\n")
    .map((l) => l.replace(/^\s*[-*]\s+/, "").trim())
    .filter((l) => l && !l.startsWith("#"));
  if (lines.length === 0) return [];
  return [
    {
      key: "legacy-notes",
      category: "reference",
      text: lines.join("; "),
      updatedAt: new Date().toISOString(),
    },
  ];
}

/**
 * 把历史遗留在 AGENTS.md 里的托管块迁出并清理(幂等:无块则不动)。
 * 旧版本把记忆写进 AGENTS.md,会污染人写文件;这里把块正文迁入机器记忆。
 */
async function migrateLegacyBlock(workspace: Workspace): Promise<void> {
  // 迁移涉及写用户仓库;任何失败都不应阻断「读取记忆 / 任务执行」,故整体兜底。
  try {
    if (!(await workspace.fs.exists("AGENTS.md"))) return;
    const content = toText(
      await workspace.fs.readFile("AGENTS.md", { encoding: "utf-8" }),
    );
    const re = legacyBlockRegex();
    const match = content.match(re);
    if (!match) return;

    // 取出块正文(去掉标记与标题),按行迁入机器记忆。
    const inner = match[0]
      .replace(LEGACY_BLOCK_START, "")
      .replace(LEGACY_BLOCK_END, "")
      .trim();
    const body = inner.startsWith(LEGACY_HEADING)
      ? inner.slice(LEGACY_HEADING.length).trim()
      : inner;
    if (body) {
      const file = workspaceEntriesPath(workspace.root);
      // 锁内 read-modify-write,避免与并发 remember/forget 互相覆盖。
      await withFileLock(file, async () => {
        const entries = await readEntries(file);
        for (const e of legacyEntriesFrom(body)) upsertEntry(entries, e);
        await writeEntries(file, entries);
      });
    }

    // 只移除块本身(连同相邻空行),不重排文件其它部分。块外手写内容原样保留。
    const cleaned = content.replace(re, "\n").trim();
    if (cleaned) {
      await workspace.fs.writeFile("AGENTS.md", `${cleaned}\n`);
    } else {
      // 该文件原本只有这个块 → 删除,而非留下一个空文件。
      await workspace.fs.rm("AGENTS.md");
    }
    console.log("[Workspace Memory] migrated legacy block out of AGENTS.md");
  } catch (err) {
    console.warn("[Workspace Memory] legacy block migration skipped:", err);
  }
}

/** 已确认迁移过(或本就无旧 .md)的 workspaceRoot,避免每次读取都试探旧文件。 */
const legacyMdChecked = new Set<string>();

/**
 * 一次性迁移旧版纯文本 `<key>.md` → 结构化 `<key>.json`,随后删除旧文件。
 * 幂等:JSON 已有内容则不覆盖,只清残留 .md;旧文件不存在则不动。
 * 读-查-写-删整段在文件锁内完成,避免与并发 remember/forget 互相覆盖(lost-update)。
 */
async function migrateLegacyMd(workspaceRoot: string): Promise<void> {
  // 进程内已检查过该工作区:无 .md 或已迁移 → 直接跳过,免去每次读取的探测开销。
  if (legacyMdChecked.has(workspaceRoot)) return;
  try {
    const mdPath = legacyMdPath(workspaceRoot);
    let mdText: string | null = null;
    try {
      mdText = (await readFile(mdPath, "utf-8")).trim() || null;
    } catch {
      mdText = null;
    }
    if (!mdText) {
      legacyMdChecked.add(workspaceRoot);
      return;
    }
    const jsonPath = workspaceEntriesPath(workspaceRoot);
    await withFileLock(jsonPath, async () => {
      // 锁内复查:并发的另一个迁移可能已写入,此时不覆盖,只清残留 .md。
      const existing = await readEntries(jsonPath);
      if (existing.length === 0) {
        await writeEntries(jsonPath, legacyEntriesFrom(mdText));
      }
      await rm(mdPath, { force: true });
    });
    legacyMdChecked.add(workspaceRoot);
  } catch (err) {
    console.warn("[Workspace Memory] legacy .md migration skipped:", err);
  }
}

/** 把一个作用域的条目渲染成 markdown 列表(带 key,便于模型复用 key 更新)。 */
function renderScope(entries: MemoryEntry[], heading: string): string {
  if (entries.length === 0) return "";
  const sorted = [...entries].sort(
    (a, b) =>
      CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category),
  );
  const lines = sorted.map((e) => `- [${e.key}] ${e.text}`);
  return `### ${heading}\n${lines.join("\n")}`;
}

/** 工作目录记忆的结构化信息(供 UI 查看用)。 */
export interface WorkspaceMemoryInfo {
  /** 工作区机器记忆文件绝对路径。 */
  agentMemoryPath: string;
  /** user 记忆文件绝对路径。 */
  userMemoryPath: string;
  /** 工作区结构化条目(供面板逐条编辑/删除)。 */
  workspaceEntries: MemoryEntry[];
  /** user 结构化条目(供面板逐条编辑/删除)。 */
  userEntries: MemoryEntry[];
  /** 命中的人写指令文件名(AGENTS.md / CLAUDE.md),无则 null。 */
  humanFile: string | null;
  /** 人写指令文件内容,无则 null。 */
  humanContent: string | null;
  /** 实际注入系统提示词的合并结果(已截断),都无则 null。 */
  combined: string | null;
}

/**
 * 汇总工作目录记忆的结构化信息(读取前先做一次性迁移)。
 * 既给系统提示词用(取 `combined`),也给「查看 Memory」面板用。
 */
export async function getWorkspaceMemoryInfo(
  workspace: Workspace,
): Promise<WorkspaceMemoryInfo> {
  await migrateLegacyBlock(workspace);
  await migrateLegacyMd(workspace.root);

  let humanFile: string | null = null;
  let humanContent: string | null = null;
  for (const file of HUMAN_INSTRUCTION_FILES) {
    if (!(await workspace.fs.exists(file))) continue;
    const t = toText(
      await workspace.fs.readFile(file, { encoding: "utf-8" }),
    ).trim();
    if (t) {
      humanFile = file;
      humanContent = t;
      break;
    }
  }

  const wsEntries = await readEntries(workspaceEntriesPath(workspace.root));
  const userEntries = await readEntries(userEntriesPath());

  const userRendered = renderScope(userEntries, "User memory (all workspaces)");
  const wsRendered = renderScope(wsEntries, "This workspace");

  // 预算分配:机器记忆是「免去重复探索」的核心负载,优先完整保留;人写内容
  // 用剩余预算。否则一个大体量 AGENTS.md 会把机器记忆挤出上限、令其永不进提示词。
  const truncated = (s: string): string =>
    `${s.slice(0, MAX_MEMORY_CHARS)}\n\n…(workspace memory truncated)`;

  let agentPart = [userRendered, wsRendered].filter(Boolean).join("\n\n");
  if (agentPart.length > MAX_MEMORY_CHARS) agentPart = truncated(agentPart);

  let humanPart = humanContent ?? "";
  const remaining = MAX_MEMORY_CHARS - agentPart.length;
  if (humanPart.length > remaining) {
    humanPart = remaining > 0 ? truncated(humanPart.slice(0, remaining)) : "";
  }

  const parts: string[] = [];
  if (humanPart.trim()) parts.push(humanPart);
  if (agentPart.trim()) parts.push(agentPart);
  const combined: string | null = parts.length ? parts.join("\n\n") : null;

  return {
    agentMemoryPath: workspaceEntriesPath(workspace.root),
    userMemoryPath: userEntriesPath(),
    workspaceEntries: wsEntries,
    userEntries,
    humanFile,
    humanContent,
    combined,
  };
}

/**
 * 读取工作目录记忆,注入系统提示词用。
 * 合并「人写指令」+「user 记忆」+「workspace 记忆」,超过上限时截断。全无则 null。
 */
export async function readWorkspaceMemory(
  workspace: Workspace,
): Promise<string | null> {
  return (await getWorkspaceMemoryInfo(workspace)).combined;
}

/** 清空当前工作区的机器记忆(user 记忆与人写文件不受影响)。 */
export async function clearWorkspaceMemory(
  workspace: Workspace,
): Promise<void> {
  const file = workspaceEntriesPath(workspace.root);
  await withFileLock(file, async () => {
    await rm(file, { force: true });
    await rm(legacyMdPath(workspace.root), { force: true });
  });
}

/** 清空 user 作用域记忆(跨工作区的个人偏好)。 */
export async function clearUserMemory(): Promise<void> {
  const file = userEntriesPath();
  await withFileLock(file, async () => {
    await rm(file, { force: true });
  });
}

/** upsert / 删除记忆的入参。 */
export interface RememberInput {
  key: string;
  scope: MemoryScope;
  category: MemoryCategory;
  text: string;
}

/**
 * 写入 / 更新一条记忆(按 key upsert,只写 app data,绝不碰用户仓库)。
 * 同一 key → 覆盖;同 category 近重复 → 合并覆盖;否则新增。
 */
export async function rememberMemory(
  workspace: Workspace,
  input: RememberInput,
): Promise<void> {
  // 敏感信息护栏放在存储层:任何写入路径(Agent 工具 / 面板编辑 IPC)都拦得住,
  // 不会把密钥/令牌持久化并注入提示。
  if (containsSecret(input.text)) {
    throw new MemorySecretError(
      "Refused to store: the text appears to contain a secret/credential.",
    );
  }
  const file =
    input.scope === "user"
      ? userEntriesPath()
      : workspaceEntriesPath(workspace.root);
  // workspace 作用域先迁移旧 .md(锁外,幂等),避免覆盖丢失历史记忆。
  if (input.scope === "workspace") await migrateLegacyMd(workspace.root);
  await withFileLock(file, async () => {
    const entries = await readEntries(file);
    upsertEntry(entries, {
      key: slugifyKey(input.key),
      category: input.category,
      text: input.text.trim(),
      updatedAt: new Date().toISOString(),
    });
    await writeEntries(file, entries);
  });
}

/** 删除指定 key 的记忆(找不到则静默)。 */
export async function forgetMemory(
  workspace: Workspace,
  scope: MemoryScope,
  key: string,
): Promise<void> {
  const file =
    scope === "user" ? userEntriesPath() : workspaceEntriesPath(workspace.root);
  const target = slugifyKey(key);
  await withFileLock(file, async () => {
    const entries = await readEntries(file);
    const next = entries.filter((e) => e.key !== target);
    if (next.length !== entries.length) await writeEntries(file, next);
  });
}
