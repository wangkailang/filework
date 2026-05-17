// SubAgentContract = structured input for Lead → Sub delegation
// (goal/input/output/termination). SubAgentReport = structured return
// the Lead consumes as a tool-result on its next turn.

import type { ModelMessage } from "ai";
import type { z } from "zod/v4";
import type { AttachmentHistoryEntry } from "../../ai/attachments";
import type { TokenUsage } from "./events";

export type SubAgentOutputFormat = "summary" | "json" | "patch" | "answer";

export interface SubAgentContract {
  /** Single-sentence statement of what this sub-agent must accomplish. */
  goal: string;

  /** Everything the sub needs to start. */
  input: {
    /** User-facing prompt fed into the sub-agent's first turn. */
    prompt: string;
    /** Files the sub can analyse. Provider-cap negotiation happens downstream. */
    attachments?: AttachmentHistoryEntry[];
    /** Explicit slice of the Lead's history. Empty → fresh context. */
    contextSlice?: ModelMessage[];
  };

  /** How the sub must shape its output. */
  output: {
    format: SubAgentOutputFormat;
    /** Required when format = "json". Used in buildReport's safeParse step. */
    schema?: z.ZodType;
    /** Compressed summary target. Default 1500. */
    maxTokens?: number;
  };

  /** Termination conditions. */
  termination: {
    /** Cap on agent-loop turns. Mapped to AgentLoop.maxStepsPerTurn. */
    maxTurns?: number;
    /** Wall-clock cap in ms. Default 120_000. */
    maxWallMs?: number;
    /** If the assistant text contains any of these substrings, stop early. */
    stopOn?: string[];
  };
}

export type SubAgentStatus = "ok" | "failed" | "cancelled" | "timeout";

export interface SubAgentReport {
  agentId: string;
  status: SubAgentStatus;
  /** Compressed natural-language summary. Always present. */
  summary: string;
  /** Structured payload when format=json/patch. Validated against contract.output.schema. */
  artifacts?: Record<string, unknown>;
  usage: TokenUsage;
  toolCallCount: number;
  durationMs: number;
  /** Populated when status != "ok". */
  error?: string;
}

export const DEFAULT_SUB_AGENT_MAX_TOKENS = 1500;
export const DEFAULT_SUB_AGENT_MAX_WALL_MS = 120_000;
export const DEFAULT_SUB_AGENT_MAX_TURNS = 10;

export interface BuildReportInput {
  agentId: string;
  contract: SubAgentContract;
  status: SubAgentStatus;
  finalText: string;
  usage: TokenUsage | undefined;
  toolCallCount: number;
  durationMs: number;
  /** Already-extracted payload when format=json/patch. Source-specific. */
  candidateArtifacts?: Record<string, unknown>;
  /** Pre-compressed summary when caller already invoked compressContext. */
  precomputedSummary?: string;
  error?: string;
}

/**
 * Materialise a `SubAgentReport` from a finished AgentLoop run.
 *
 * The caller is responsible for invoking `compressContext` from
 * `src/main/ai/context-compressor.ts` ahead of time when the summary
 * would exceed `contract.output.maxTokens` — `precomputedSummary` is
 * how it gets back here. For format=json, this function validates
 * `candidateArtifacts` against the contract schema and downgrades to
 * status="failed" on a schema miss.
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
 * Best-effort `candidateArtifacts` extractor for format=json. Walks the
 * assistant's final text for the last fenced ```json``` block or the
 * outermost JSON object literal. Returns undefined if no JSON could be
 * isolated — the caller flips to status=failed via buildReport.
 */
export function extractJsonArtifacts(
  finalText: string,
): Record<string, unknown> | undefined {
  // Prefer fenced ```json blocks — they survive prose around the answer.
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
