/**
 * Shared types for the GAIA harness — kept thin so dataset/scorer/runner
 * stay decoupled. Field names that come from the GAIA dataset JSONL
 * mirror the upstream casing (e.g. `"Final answer"`) and are translated
 * into `camelCase` in `NormalizedQuestion` so downstream code reads
 * naturally.
 */

// ─── Upstream dataset shape ──────────────────────────────────────────

/** Raw record as it appears in GAIA's `metadata.jsonl`. */
export interface GaiaRawQuestion {
  task_id: string;
  Question: string;
  Level: number;
  "Final answer": string;
  /** Empty string when the question has no attachment. */
  file_name: string;
  "Annotator Metadata"?: {
    Steps?: string;
    Tools?: string;
    Number_of_steps?: string;
    "How long did this take?"?: string;
    "Number of tools"?: string;
  };
}

// ─── Normalised in-process shape ─────────────────────────────────────

export type GaiaLevel = 1 | 2 | 3;

export interface NormalizedQuestion {
  taskId: string;
  level: GaiaLevel;
  question: string;
  groundTruth: string;
  /** Filename relative to the dataset directory; `null` when no attachment. */
  fileName: string | null;
  /** Human-readable reasoning notes from the dataset — dev-only, not shown to the agent. */
  annotatorSteps?: string;
}

// ─── Run results ─────────────────────────────────────────────────────

export type FailureTag =
  /** Agent produced no tool calls at all (likely hallucinated from training). */
  | "no_tool_calls"
  /** A tool returned an error and the agent did not recover. */
  | "tool_error"
  /** Agent hit max steps / context cap before answering. */
  | "context_overflow"
  /** Question has an attachment but no tool call touched the file. */
  | "attachment_not_processed"
  /** Long chain of tool calls but the final extracted answer was wrong. */
  | "wrong_answer_correct_path"
  /** Reflection-gate didn't fire on a long chain (likely missed self-correction). */
  | "reflection_not_fired"
  /** Per-question timeout exceeded. */
  | "timeout"
  /** Runner threw an uncaught exception. */
  | "exception";

export interface ToolCallRecord {
  name: string;
  args: unknown;
  result?: unknown;
  error?: string;
  durationMs: number;
}

export interface TokenUsage {
  input: number;
  output: number;
  total: number;
}

export interface QuestionResult {
  taskId: string;
  level: GaiaLevel;
  question: string;
  /** Absolute path to the attachment in the question's workspace, or `null`. */
  attachment: string | null;
  groundTruth: string;
  /** What the agent actually said as its final answer; `null` if extraction failed. */
  predicted: string | null;
  passed: boolean;
  normalized: { groundTruth: string; predicted: string };
  durationMs: number;
  tokenUsage?: TokenUsage;
  estimatedCostUsd?: number;
  toolCalls: ToolCallRecord[];
  stepCount: number;
  reflectionFired: boolean;
  failureTags: FailureTag[];
  /** Stack trace when `failureTags` contains `"exception"`. */
  exception?: string;
  /** Relative path to the JSONL with the full event stream. */
  eventsPath: string;
}

export interface RunSummary {
  config: {
    level: "1" | "2" | "3" | "all";
    limit: number | null;
    provider: string;
    model: string;
    branch?: string;
    commit?: string;
    startedAt: string;
    finishedAt: string;
  };
  totals: { questions: number; passed: number; failed: number };
  accuracy: number;
  byLevel: Record<string, { n: number; passed: number; accuracy: number }>;
  duration: { totalMs: number; medianMs: number };
  cost: { totalUsd: number; perQuestionMedianUsd: number };
  failureTags: Partial<Record<FailureTag, number>>;
  /**
   * Trajectory quality metrics — median steps, tool redundancy, and
   * reflection effectiveness. Optional so older `summary.json` files
   * still load through `gaia-eval-diff`. New runs always populate it.
   */
  quality?: import("./metrics").QualityMetrics;
}

// ─── Configuration ───────────────────────────────────────────────────

export interface RunnerOptions {
  /** Absolute path to GAIA's `validation/` dir (or equivalent) containing `metadata.jsonl` + attachments. */
  datasetDir: string;
  /** Where to write per-question JSON and the summary. */
  outputDir: string;
  level: GaiaLevel | "all";
  limit: number | null;
  /** Model config — bypass the app's DB, pass directly so the CLI is self-contained. */
  provider: string;
  apiKey: string;
  model: string;
  baseUrl?: string;
  /** Per-question hard timeout in ms. Default 5 minutes. */
  perQuestionTimeoutMs?: number;
  /** Concurrency cap. v1 enforces 1 — kept here for future expansion. */
  concurrency?: number;
  /**
   * Sampling temperature passed to both the main streamText call and the
   * reflection-gate's LLM verifier. Default `0` (deterministic). Pass
   * `null` to omit the parameter entirely — required for OpenAI reasoning
   * models (o1/o3/o5/gpt-5 reasoning) which reject any `temperature`
   * setting and emit an SDK warning.
   */
  temperature?: number | null;
}
