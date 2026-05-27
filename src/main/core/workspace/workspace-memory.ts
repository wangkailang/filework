/**
 * 工作目录级记忆（per-workspace memory）—— 仓库零足迹版。
 *
 * 设计原则(对标 Claude Code / ChatGPT 的做法):人写的指令与机器写的记忆分离。
 *  - 读:合并注入「人写的 AGENTS.md / CLAUDE.md(只读)」+「机器记忆」。
 *  - 写:只写机器记忆,落到应用数据目录 ~/.filework/workspace-memory/<key>.md,
 *    按工作目录路径哈希索引,绝不写进用户仓库,零 git 噪声。
 *  - 迁移:历史版本曾把记忆以 <!-- filework:memory --> 托管块写进 AGENTS.md,
 *    这里一次性把它迁出到机器记忆,并从 AGENTS.md 清除,恢复文件干净。
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

/**
 * 机器记忆根目录,默认 ~/.filework/workspace-memory(与 ~/.filework/sessions 对齐)。
 * 测试可用 {@link setWorkspaceMemoryRoot} 覆盖,避免污染真实用户数据。
 */
let memoryRoot = path.join(homedir(), ".filework", "workspace-memory");

/** 覆盖机器记忆根目录(bootstrap / 测试用)。 */
export function setWorkspaceMemoryRoot(dir: string): void {
  memoryRoot = dir;
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

/** 机器记忆文件路径(按工作目录哈希)。 */
function memoryFilePath(workspaceRoot: string): string {
  return path.join(memoryRoot, `${workspaceKey(workspaceRoot)}.md`);
}

/** 读机器记忆(不存在或为空返回 null)。 */
async function readAgentMemory(workspaceRoot: string): Promise<string | null> {
  try {
    const t = (await readFile(memoryFilePath(workspaceRoot), "utf-8")).trim();
    return t || null;
  } catch {
    return null;
  }
}

/**
 * 把历史遗留在 AGENTS.md 里的托管块迁出并清理(幂等:无块则不动)。
 *
 * 旧版本把记忆写进 AGENTS.md,会污染人写文件。这里把块正文迁入机器记忆,
 * 再从 AGENTS.md 抹掉该块、压掉多余空行,恢复文件干净。
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

    // 取出块正文(去掉标记与标题),合并进机器记忆。
    const inner = match[0]
      .replace(LEGACY_BLOCK_START, "")
      .replace(LEGACY_BLOCK_END, "")
      .trim();
    const body = inner.startsWith(LEGACY_HEADING)
      ? inner.slice(LEGACY_HEADING.length).trim()
      : inner;
    if (body) {
      const prev = await readAgentMemory(workspace.root);
      if (!prev?.includes(body)) {
        await updateWorkspaceMemory(workspace, body, "append");
      }
    }

    // 只移除块本身(连同相邻空行),不重排文件其它部分。块外的手写内容原样保留。
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

/** 工作目录记忆的结构化信息(供 UI 查看用)。 */
export interface WorkspaceMemoryInfo {
  /** 机器记忆正文(app data),无则 null。 */
  agentMemory: string | null;
  /** 机器记忆文件绝对路径。 */
  agentMemoryPath: string;
  /** 命中的人写指令文件名(AGENTS.md / CLAUDE.md),无则 null。 */
  humanFile: string | null;
  /** 人写指令文件内容,无则 null。 */
  humanContent: string | null;
  /** 实际注入系统提示词的合并结果(已截断),两者都无则 null。 */
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

  const agentMemory = await readAgentMemory(workspace.root);

  // 预算分配:机器记忆是「免去重复探索」的核心负载,优先完整保留;人写内容
  // 用剩余预算。否则一个大体量 AGENTS.md 会把机器记忆挤出上限、令其永不进提示词。
  const truncated = (s: string): string =>
    `${s.slice(0, MAX_MEMORY_CHARS)}\n\n…(workspace memory truncated)`;

  let agentPart = agentMemory ?? "";
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
    agentMemory,
    agentMemoryPath: memoryFilePath(workspace.root),
    humanFile,
    humanContent,
    combined,
  };
}

/**
 * 读取工作目录记忆,注入系统提示词用。
 *
 * 合并「人写指令(AGENTS.md / CLAUDE.md,只读,取首个存在者)」+「机器记忆
 * (app data)」,超过上限时截断。两者都没有则返回 null。
 */
export async function readWorkspaceMemory(
  workspace: Workspace,
): Promise<string | null> {
  return (await getWorkspaceMemoryInfo(workspace)).combined;
}

/** 清空机器记忆(删除 app data 文件;人写的 AGENTS.md/CLAUDE.md 不受影响)。 */
export async function clearWorkspaceMemory(
  workspace: Workspace,
): Promise<void> {
  await rm(memoryFilePath(workspace.root), { force: true });
}

/**
 * 写入 / 更新机器记忆(只写 app data,绝不碰用户仓库)。
 *  - `append`(默认):追加到现有记忆之后。
 *  - `replace`:整体覆盖。
 */
export async function updateWorkspaceMemory(
  workspace: Workspace,
  content: string,
  mode: "replace" | "append" = "append",
): Promise<void> {
  const file = memoryFilePath(workspace.root);
  await mkdir(path.dirname(file), { recursive: true });
  let body = content.trim();
  if (mode === "append") {
    const prev = await readAgentMemory(workspace.root);
    if (prev) {
      // 去重:已包含该内容则跳过,避免重复追加导致文件无意义膨胀。
      if (prev.includes(body)) return;
      body = `${prev}\n${body}`;
    }
  }
  // 原子写:先写临时文件再 rename 覆盖,避免并发/崩溃留下半写文件。
  const tmp = `${file}.${randomUUID()}.tmp`;
  await writeFile(tmp, `${body}\n`, "utf-8");
  await rename(tmp, file);
}
