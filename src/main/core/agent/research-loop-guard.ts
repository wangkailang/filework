import type {
  BeforeToolCallDecision,
  ToolObservedResult,
} from "./tool-registry";

const WEB_SEARCH_TOOL = "webSearch";
const WEB_FETCH_TOOLS = new Set(["webFetch", "webFetchRendered", "webScrape"]);
const RESULT_TOOL = "submitSubagentResult";

export interface ResearchLoopGuardConfig {
  maxWebSearchCalls: number;
  maxWebFetchCalls: number;
  repeatedCallThreshold: number;
  maxConsecutiveLowNoveltySearches: number;
  minNoveltyRatio: number;
  similarQueryThreshold: number;
  minSearchCallsBeforeVerification: number;
  minDiscoveredSourcesBeforeVerification: number;
  minDiscoveredSourceHostsBeforeVerification: number;
  minVerifiedSourcesBeforeFinalization: number;
}

export const DEFAULT_RESEARCH_LOOP_GUARD_CONFIG: ResearchLoopGuardConfig = {
  maxWebSearchCalls: 4,
  maxWebFetchCalls: 4,
  repeatedCallThreshold: 3,
  maxConsecutiveLowNoveltySearches: 2,
  minNoveltyRatio: 0.2,
  similarQueryThreshold: 0.65,
  minSearchCallsBeforeVerification: 2,
  minDiscoveredSourcesBeforeVerification: 5,
  minDiscoveredSourceHostsBeforeVerification: 2,
  minVerifiedSourcesBeforeFinalization: 3,
};

export type ResearchPhase = "discovery" | "verification" | "finalization";

export interface ResearchStepPolicy {
  activeTools: string[];
  toolChoice: "auto" | { type: "tool"; toolName: typeof RESULT_TOOL };
  message: string;
}

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, canonicalize(item)]),
  );
};

const callSignature = (toolName: string, args: unknown): string =>
  `${toolName}:${JSON.stringify(canonicalize(args))}`;

const queryFromArgs = (args: unknown): string => {
  if (!args || typeof args !== "object") return "";
  const query = (args as { query?: unknown }).query;
  return typeof query === "string" ? query : "";
};

const normalizeQueryToken = (token: string): string => {
  if (token === "documentation" || token === "docs") return "doc";
  if (token.length > 4 && token.endsWith("s")) return token.slice(0, -1);
  return token;
};

const queryTokens = (query: string): Set<string> =>
  new Set(
    query
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu)
      ?.map(normalizeQueryToken)
      .filter(Boolean) ?? [],
  );

const querySimilarity = (left: string, right: string): number => {
  const a = queryTokens(left);
  const b = queryTokens(right);
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection++;
  }
  return intersection / (a.size + b.size - intersection);
};

const extractResultUrls = (rawOutput: unknown): string[] => {
  if (!rawOutput || typeof rawOutput !== "object") return [];
  const results = (rawOutput as { results?: unknown }).results;
  if (!Array.isArray(results)) return [];
  return Array.from(
    new Set(
      results
        .map((item) =>
          item && typeof item === "object"
            ? (item as { url?: unknown }).url
            : undefined,
        )
        .filter((url): url is string => typeof url === "string" && url !== ""),
    ),
  );
};

const urlFromArgs = (args: unknown): string => {
  if (!args || typeof args !== "object") return "";
  const url = (args as { url?: unknown }).url;
  return typeof url === "string" ? url : "";
};

const sourceHost = (url: string): string => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
};

const MIN_VERIFIED_CONTENT_CHARS = 120;

const outputHasUsableContent = (rawOutput: unknown): boolean => {
  if (rawOutput === null || rawOutput === undefined) return false;
  if (typeof rawOutput !== "object") {
    return String(rawOutput).trim().length >= MIN_VERIFIED_CONTENT_CHARS;
  }
  const output = rawOutput as {
    success?: unknown;
    error?: unknown;
    status?: unknown;
  };
  if (
    output.success === false ||
    output.error ||
    (typeof output.status === "number" && output.status >= 400)
  ) {
    return false;
  }
  return ["markdown", "raw", "html", "content", "text"].some((field) => {
    const value = (rawOutput as Record<string, unknown>)[field];
    return (
      typeof value === "string" &&
      value.trim().length >= MIN_VERIFIED_CONTENT_CHARS
    );
  });
};

const phaseTransitionResult = (
  reason: string,
  nextAction: "verify_sources" | "submit_result",
) => ({
  success: true,
  skipped: true,
  reason,
  nextAction,
});

/** Per-run research guard: bounded calls, exact-loop detection, and source novelty. */
export class ResearchLoopGuard {
  private readonly config: ResearchLoopGuardConfig;
  private webSearchCalls = 0;
  private webFetchCalls = 0;
  private lastCallSignature = "";
  private repeatedCallCount = 0;
  private previousSearchQuery = "";
  private consecutiveLowNoveltySearches = 0;
  private readonly seenUrls = new Set<string>();
  private readonly seenSourceHosts = new Set<string>();
  private readonly verifiedUrls = new Set<string>();
  private phase: ResearchPhase = "discovery";
  private phaseReason = "";

  constructor(config: Partial<ResearchLoopGuardConfig> = {}) {
    this.config = { ...DEFAULT_RESEARCH_LOOP_GUARD_CONFIG, ...config };
  }

  getPhase(): ResearchPhase {
    return this.phase;
  }

  getStepPolicy(availableTools: string[]): ResearchStepPolicy | undefined {
    if (this.phase === "discovery") return undefined;
    if (this.phase === "verification") {
      return {
        // AI SDK 用 activeTools 同时控制“暴露给模型”和“解析模型调用”的
        // 工具集合。保留完整集合,让模型偶发生成的滞后搜索仍能进入
        // beforeToolCall,由下方相位守卫转换成成功的 skipped 结果；否则
        // SDK 会先抛 AI_NoSuchToolError,执行前守卫没有机会接管。
        activeTools: availableTools,
        toolChoice: "auto",
        message: `${this.phaseReason} Search discovery is complete. Verify the best distinct primary sources already found, then submit the result; do not reformulate the search.`,
      };
    }
    return {
      // finalization 仍用显式 toolChoice 强制提交；完整解析集合用于让
      // 违反工具选择的滞后调用安全落到 skipped,而不成为工具错误。
      activeTools: availableTools,
      toolChoice: { type: "tool", toolName: RESULT_TOOL },
      message: `${this.phaseReason} Evidence collection is complete. Call submitSubagentResult now with the best supported findings and any explicit gaps.`,
    };
  }

  private moveToVerification(reason: string): void {
    if (this.phase !== "discovery") return;
    this.phase = "verification";
    this.phaseReason = reason;
  }

  private moveToFinalization(reason: string): void {
    this.phase = "finalization";
    this.phaseReason = reason;
  }

  private skippedForCurrentPhase(): BeforeToolCallDecision {
    const nextAction =
      this.phase === "verification" ? "verify_sources" : "submit_result";
    const reason =
      this.phaseReason ||
      (this.phase === "verification"
        ? "Search discovery is complete."
        : "Evidence collection is complete.");
    return {
      allow: false,
      reason,
      result: phaseTransitionResult(reason, nextAction),
    };
  }

  beforeToolCall(call: {
    toolName: string;
    toolCallId: string;
    args: unknown;
  }): BeforeToolCallDecision {
    if (call.toolName === RESULT_TOOL) return { allow: true };
    if (this.phase === "finalization") {
      return this.skippedForCurrentPhase();
    }
    if (this.phase === "verification" && call.toolName === WEB_SEARCH_TOOL) {
      return this.skippedForCurrentPhase();
    }

    if (
      call.toolName === WEB_SEARCH_TOOL ||
      WEB_FETCH_TOOLS.has(call.toolName)
    ) {
      const signature = callSignature(call.toolName, call.args);
      if (signature === this.lastCallSignature) {
        this.repeatedCallCount++;
      } else {
        this.lastCallSignature = signature;
        this.repeatedCallCount = 1;
      }
      if (this.repeatedCallCount >= this.config.repeatedCallThreshold) {
        if (call.toolName === WEB_SEARCH_TOOL) {
          this.moveToVerification(
            "Repeated search detected; no additional discovery value was added.",
          );
        } else {
          this.moveToFinalization(
            "Repeated source fetch detected; use the evidence already collected.",
          );
        }
        return this.skippedForCurrentPhase();
      }
    }

    if (call.toolName === WEB_SEARCH_TOOL) {
      if (this.webSearchCalls >= this.config.maxWebSearchCalls) {
        this.moveToVerification(
          `Focused search budget reached (${this.config.maxWebSearchCalls}).`,
        );
        return this.skippedForCurrentPhase();
      }
      this.webSearchCalls++;
      if (this.webSearchCalls >= this.config.maxWebSearchCalls) {
        this.moveToVerification(
          `Focused search budget reached (${this.config.maxWebSearchCalls}).`,
        );
      }
    } else if (WEB_FETCH_TOOLS.has(call.toolName)) {
      if (this.webFetchCalls >= this.config.maxWebFetchCalls) {
        this.moveToFinalization(
          `Source verification budget reached (${this.config.maxWebFetchCalls}).`,
        );
        return this.skippedForCurrentPhase();
      }
      this.webFetchCalls++;
      if (this.webFetchCalls >= this.config.maxWebFetchCalls) {
        this.moveToFinalization(
          `Source verification budget reached (${this.config.maxWebFetchCalls}).`,
        );
      }
    }

    return { allow: true };
  }

  observeToolResult(result: ToolObservedResult): void {
    if (WEB_FETCH_TOOLS.has(result.toolName)) {
      const url = urlFromArgs(result.args);
      if (url && outputHasUsableContent(result.rawOutput)) {
        this.verifiedUrls.add(url);
      }
      if (
        this.verifiedUrls.size >=
        this.config.minVerifiedSourcesBeforeFinalization
      ) {
        this.moveToFinalization(
          `${this.verifiedUrls.size} distinct sources were verified.`,
        );
      }
      return;
    }
    if (result.toolName !== WEB_SEARCH_TOOL) return;
    const query = queryFromArgs(result.args);
    const urls = extractResultUrls(result.rawOutput);
    let novelCount = 0;
    for (const url of urls) {
      if (!this.seenUrls.has(url)) novelCount++;
      this.seenUrls.add(url);
      const host = sourceHost(url);
      if (host) this.seenSourceHosts.add(host);
    }
    const noveltyRatio = urls.length > 0 ? novelCount / urls.length : 0;
    const similarToPrevious =
      this.previousSearchQuery !== "" &&
      querySimilarity(query, this.previousSearchQuery) >=
        this.config.similarQueryThreshold;

    if (similarToPrevious && noveltyRatio < this.config.minNoveltyRatio) {
      this.consecutiveLowNoveltySearches++;
    } else {
      this.consecutiveLowNoveltySearches = 0;
    }
    this.previousSearchQuery = query;

    if (
      this.consecutiveLowNoveltySearches >=
      this.config.maxConsecutiveLowNoveltySearches
    ) {
      this.moveToVerification(
        "Similar searches are no longer producing new sources.",
      );
    } else if (
      this.webSearchCalls >= this.config.minSearchCallsBeforeVerification &&
      this.seenUrls.size >=
        this.config.minDiscoveredSourcesBeforeVerification &&
      this.seenSourceHosts.size >=
        this.config.minDiscoveredSourceHostsBeforeVerification
    ) {
      this.moveToVerification(
        `${this.seenUrls.size} distinct candidate sources were discovered across ${this.webSearchCalls} focused searches.`,
      );
    }
  }
}
