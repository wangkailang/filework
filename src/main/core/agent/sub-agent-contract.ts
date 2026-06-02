// SubAgentContract = Lead → Sub 委派的结构化输入
// (goal/input/output/termination)。SubAgentReport = 结构化返回值,
// Lead 在下一回合将其作为 tool-result 消费。

import type { ModelMessage } from "ai";
import type { z } from "zod/v4";
import type { AttachmentHistoryEntry } from "../../ai/attachments";
import type { TokenUsage } from "./events";

export type SubAgentOutputFormat = "summary" | "json" | "patch" | "answer";

export interface SubAgentContract {
  /** 用一句话陈述该 sub-agent 必须完成的目标。 */
  goal: string;

  /** sub-agent 启动所需的一切。 */
  input: {
    /** 喂入 sub-agent 首个回合、面向用户的 prompt。 */
    prompt: string;
    /** sub 可分析的文件。Provider 上限协商在下游进行。 */
    attachments?: AttachmentHistoryEntry[];
    /** 从 Lead 历史中显式切出的片段。为空 → 全新上下文。 */
    contextSlice?: ModelMessage[];
  };

  /** sub 必须如何组织其输出。 */
  output: {
    format: SubAgentOutputFormat;
    /** format = "json" 时必填。用于 buildReport 的 safeParse 步骤。 */
    schema?: z.ZodType;
    /** 压缩后摘要的目标长度。默认 1500。 */
    maxTokens?: number;
  };

  /** 终止条件。 */
  termination: {
    /** agent-loop 回合数上限。映射到 AgentLoop.maxStepsPerTurn。 */
    maxTurns?: number;
    /** 墙钟时间上限(毫秒)。默认 120_000。 */
    maxWallMs?: number;
    /** 累计 token 上限(input+output)。映射到 AgentLoop.maxTotalTokens。默认 60_000。 */
    maxTotalTokens?: number;
    /** 若助手文本包含其中任一子串,则提前停止。 */
    stopOn?: string[];
  };
}

export type SubAgentStatus =
  | "ok"
  | "failed"
  | "cancelled"
  | "timeout"
  | "token_limit";

export interface SubAgentReport {
  agentId: string;
  status: SubAgentStatus;
  /** 压缩后的自然语言摘要。始终存在。 */
  summary: string;
  /** format=json/patch 时的结构化载荷。会针对 contract.output.schema 做校验。 */
  artifacts?: Record<string, unknown>;
  usage: TokenUsage;
  toolCallCount: number;
  durationMs: number;
  /** 当 status != "ok" 时填充。 */
  error?: string;
}

export const DEFAULT_SUB_AGENT_MAX_TOKENS = 1500;
export const DEFAULT_SUB_AGENT_MAX_WALL_MS = 120_000;
export const DEFAULT_SUB_AGENT_MAX_TURNS = 10;
/** 子 agent 累计 token 硬上限默认值(input+output)。 */
export const DEFAULT_SUB_AGENT_MAX_TOTAL_TOKENS = 60_000;

export interface BuildReportInput {
  agentId: string;
  contract: SubAgentContract;
  status: SubAgentStatus;
  finalText: string;
  usage: TokenUsage | undefined;
  toolCallCount: number;
  durationMs: number;
  /** format=json/patch 时已提取的载荷。来源相关。 */
  candidateArtifacts?: Record<string, unknown>;
  /** 调用方已调用 compressContext 时预先压缩好的摘要。 */
  precomputedSummary?: string;
  error?: string;
}

/**
 * 从一次已结束的 AgentLoop 运行中物化出 `SubAgentReport`。
 *
 * 当摘要会超过 `contract.output.maxTokens` 时,调用方负责提前调用
 * `src/main/ai/context-compressor.ts` 中的 `compressContext` ——
 * `precomputedSummary` 正是其回传到这里的途径。对 format=json,
 * 本函数会针对 contract schema 校验 `candidateArtifacts`,校验不通过
 * 时降级为 status="failed"。
 */
export function buildReport(input: BuildReportInput): SubAgentReport {
  const {
    agentId,
    contract,
    status,
    finalText,
    usage,
    toolCallCount,
    durationMs,
    candidateArtifacts,
    precomputedSummary,
    error,
  } = input;

  const summary = precomputedSummary ?? finalText.trim();

  let artifacts: Record<string, unknown> | undefined;
  let finalStatus = status;
  let finalError = error;

  if (status === "ok" && contract.output.format === "json") {
    if (!contract.output.schema) {
      finalStatus = "failed";
      finalError =
        "contract.output.schema is required when format=json but was not provided";
    } else if (candidateArtifacts === undefined) {
      finalStatus = "failed";
      finalError = "format=json contract produced no parseable artifacts";
    } else {
      const parsed = contract.output.schema.safeParse(candidateArtifacts);
      if (parsed.success) {
        artifacts = parsed.data as Record<string, unknown>;
      } else {
        finalStatus = "failed";
        finalError = `sub-agent artifacts failed schema validation: ${parsed.error.message}`;
      }
    }
  } else if (candidateArtifacts) {
    artifacts = candidateArtifacts;
  }

  return {
    agentId,
    status: finalStatus,
    summary,
    artifacts,
    usage: usage ?? {
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
    },
    toolCallCount,
    durationMs,
    error: finalError,
  };
}

/**
 * 面向 format=json 的尽力而为型 `candidateArtifacts` 提取器。在助手的
 * 最终文本中查找最后一个 ```json``` 围栏块或最外层的 JSON 对象字面量。
 * 若无法分离出任何 JSON 则返回 undefined —— 调用方会经由 buildReport
 * 翻转为 status=failed。
 */
export function extractJsonArtifacts(
  finalText: string,
): Record<string, unknown> | undefined {
  // 优先使用 ```json 围栏块 —— 它们能在答案周围夹杂散文时依然可靠提取。
  const fenceMatch = finalText.match(/```json\s*([\s\S]*?)\s*```/i);
  const candidate = fenceMatch
    ? fenceMatch[1]
    : isolateOuterJsonObject(finalText);
  if (!candidate) return undefined;
  try {
    const parsed = JSON.parse(candidate);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function isolateOuterJsonObject(text: string): string | undefined {
  const start = text.indexOf("{");
  if (start === -1) return undefined;
  let depth = 0;
  let inString = false;
  let escapedNext = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escapedNext) {
      escapedNext = false;
      continue;
    }
    if (inString) {
      if (ch === "\\") escapedNext = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}
