/**
 * GAIA harness 的共享类型 —— 保持精简,使 dataset/scorer/runner 之间
 * 保持解耦。来自 GAIA 数据集 JSONL 的字段名沿用上游的大小写
 * (例如 `"Final answer"`),并在 `NormalizedQuestion` 中转换为
 * `camelCase`,以便下游代码读起来更自然。
 */

// ─── 上游数据集结构 ──────────────────────────────────────────

/** GAIA 的 `metadata.jsonl` 中出现的原始记录。 */
export interface GaiaRawQuestion {
  task_id: string;
  Question: string;
  Level: number;
  "Final answer": string;
  /** 题目无附件时为空字符串。 */
  file_name: string;
  "Annotator Metadata"?: {
    Steps?: string;
    Tools?: string;
    Number_of_steps?: string;
    "How long did this take?"?: string;
    "Number of tools"?: string;
  };
}

// ─── 进程内归一化结构 ─────────────────────────────────────

export type GaiaLevel = 1 | 2 | 3;

export interface NormalizedQuestion {
  taskId: string;
  level: GaiaLevel;
  question: string;
  groundTruth: string;
  /** 相对于数据集目录的文件名;无附件时为 `null`。 */
  fileName: string | null;
  /** 数据集中人类可读的推理注记 —— 仅供开发使用,不展示给 agent。 */
  annotatorSteps?: string;
}

// ─── 运行结果 ─────────────────────────────────────────────────────

export type FailureTag =
  /** Agent 完全没有产生任何工具调用(很可能是凭训练记忆臆造)。 */
  | "no_tool_calls"
  /** 某个工具返回了错误且 agent 未能恢复。 */
  | "tool_error"
  /** Agent 在作答前撞上了最大步数 / 上下文上限。 */
  | "context_overflow"
  /** 题目带有附件,但没有任何工具调用触及该文件。 */
  | "attachment_not_processed"
  /** 工具调用链很长,但最终提取出的答案是错的。 */
  | "wrong_answer_correct_path"
  /** Reflection-gate 在长链上未触发(很可能错失了自我纠正)。 */
  | "reflection_not_fired"
  /** 超出单题超时限制。 */
  | "timeout"
  /** Runner 抛出了未捕获的异常。 */
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
  /** 题目工作区中附件的绝对路径,或 `null`。 */
  attachment: string | null;
  groundTruth: string;
  /** agent 实际给出的最终答案;提取失败时为 `null`。 */
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
  /** 当 `failureTags` 包含 `"exception"` 时的堆栈跟踪。 */
  exception?: string;
  /** 指向包含完整事件流的 JSONL 的相对路径。 */
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
   * 轨迹质量指标 —— 步数中位数、工具冗余度,以及 reflection 的有效性。
   * 设为可选,使较旧的 `summary.json` 文件仍能通过 `gaia-eval-diff`
   * 加载。新的运行总会填充该字段。
   */
  quality?: import("./metrics").QualityMetrics;
}

// ─── 配置 ───────────────────────────────────────────────────

export interface RunnerOptions {
  /** GAIA 的 `validation/` 目录(或等价目录)的绝对路径,内含 `metadata.jsonl` + 附件。 */
  datasetDir: string;
  /** 写入每道题 JSON 与汇总的位置。 */
  outputDir: string;
  level: GaiaLevel | "all";
  limit: number | null;
  /** 模型配置 —— 绕过应用的 DB,直接传入,使 CLI 自包含。 */
  provider: string;
  apiKey: string;
  model: string;
  baseUrl?: string;
  /** 单题硬超时,单位毫秒。默认 5 分钟。 */
  perQuestionTimeoutMs?: number;
  /** 并发上限。v1 强制为 1 —— 保留在此以备将来扩展。 */
  concurrency?: number;
  /**
   * 同时传给主 streamText 调用与 reflection-gate 的 LLM 校验器的采样
   * 温度。默认 `0`(确定性)。传 `null` 以完全省略该参数 ——
   * OpenAI 推理模型(o1/o3/o5/gpt-5 reasoning)要求如此,它们会拒绝
   * 任何 `temperature` 设置并发出 SDK 警告。
   */
  temperature?: number | null;
}
