// 钻入面板:在 ContextDock 的 subagent 标签里回放单个子 agent 的执行过程。
// 数据来自 chat context 的 messages(随子 agent 流式实时更新),按 batchId 定位
// SubagentMessagePart、childTaskId 定位 child,复用主线程的工具/推理/文本渲染。
import {
  BookOpenCheck,
  ChevronRight,
  CircleAlert,
  Search,
  Send,
} from "lucide-react";
import { type ReactNode, useMemo } from "react";

import { useI18nContext } from "../../i18n/i18n-react";
import { MessageResponse } from "../ai-elements/message";
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from "../ai-elements/tool";
import { useChatSessionContext } from "./ChatSessionProvider";
import { ReasoningBlock } from "./ReasoningBlock";
import { getSubagentDisplayStatus, StatusBadge } from "./SubagentCard";
import type {
  MessagePart,
  ReasoningPart,
  SubagentChildView,
  SubagentMessagePart,
  ToolPart,
} from "./types";

function fmtTokens(n: number | null): string | null {
  if (n == null) return null;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

const RESEARCH_SEARCH_TOOL = "webSearch";
const RESEARCH_FETCH_TOOLS = new Set([
  "webFetch",
  "webFetchRendered",
  "webScrape",
]);
const RESEARCH_SUBMIT_TOOL = "submitSubagentResult";
const MIN_VERIFIED_CONTENT_CHARS = 120;

type SubmissionState = "idle" | "running" | "complete" | "failed";

interface ResearchTraceSummary {
  calls: ToolPart[];
  completedSearches: number;
  completedFetches: number;
  verifiedSources: number;
  skippedCalls: number;
  failedCalls: number;
  submission: SubmissionState;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function isWebResearchTool(part: MessagePart): boolean {
  return (
    part.type === "tool" &&
    (part.toolName === RESEARCH_SEARCH_TOOL ||
      RESEARCH_FETCH_TOOLS.has(part.toolName))
  );
}

function isResearchTool(part: MessagePart): part is ToolPart {
  return (
    isWebResearchTool(part) ||
    (part.type === "tool" && part.toolName === RESEARCH_SUBMIT_TOOL)
  );
}

function isSkippedCall(part: ToolPart): boolean {
  return asRecord(part.result)?.skipped === true;
}

function isFailedCall(part: ToolPart): boolean {
  if (part.state === "output-error") return true;
  const output = asRecord(part.result);
  return Boolean(
    output?.success === false ||
      output?.error ||
      (typeof output?.status === "number" && output.status >= 400),
  );
}

function hasVerifiedContent(result: unknown): boolean {
  const output = asRecord(result);
  if (!output) {
    return (
      typeof result === "string" &&
      result.trim().length >= MIN_VERIFIED_CONTENT_CHARS
    );
  }
  return ["markdown", "raw", "html", "content", "text"].some((field) => {
    const value = output[field];
    return (
      typeof value === "string" &&
      value.trim().length >= MIN_VERIFIED_CONTENT_CHARS
    );
  });
}

function urlFromArgs(args: unknown): string | null {
  const url = asRecord(args)?.url;
  return typeof url === "string" && url.trim() ? url.trim() : null;
}

function summarizeResearchTrace(
  parts: MessagePart[],
): ResearchTraceSummary | null {
  if (!parts.some(isWebResearchTool)) return null;
  const calls = parts.filter(isResearchTool);

  const verifiedUrls = new Set<string>();
  let completedSearches = 0;
  let completedFetches = 0;
  let skippedCalls = 0;
  let failedCalls = 0;
  let submission: SubmissionState = "idle";

  for (const call of calls) {
    const skipped = isSkippedCall(call);
    const failed = isFailedCall(call);
    if (skipped) skippedCalls++;
    if (failed) failedCalls++;

    if (call.toolName === RESEARCH_SUBMIT_TOOL) {
      submission = failed
        ? "failed"
        : call.state === "output-available"
          ? "complete"
          : "running";
      continue;
    }
    if (skipped || failed || call.state !== "output-available") continue;

    if (call.toolName === RESEARCH_SEARCH_TOOL) {
      completedSearches++;
      continue;
    }

    completedFetches++;
    const url = urlFromArgs(call.args);
    if (url && hasVerifiedContent(call.result)) verifiedUrls.add(url);
  }

  return {
    calls,
    completedSearches,
    completedFetches,
    verifiedSources: verifiedUrls.size,
    skippedCalls,
    failedCalls,
    submission,
  };
}

function ResearchStage({
  icon,
  label,
  value,
  detail,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <div className="min-w-0 px-2.5 py-2">
      <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
        {icon}
        <span>{label}</span>
      </div>
      <div className="mt-0.5 truncate text-xs font-medium text-foreground/85">
        {value}
      </div>
      {detail && (
        <div className="mt-0.5 truncate text-[10px] text-muted-foreground/75">
          {detail}
        </div>
      )}
    </div>
  );
}

function submissionLabel(
  state: SubmissionState,
  childStatus: SubagentChildView["status"],
): string {
  if (state === "complete") return "已提交";
  if (state === "failed") return "提交失败";
  if (state === "running") return "提交中";
  return childStatus === "queued" || childStatus === "running"
    ? "待提交"
    : "未提交";
}

function ResearchTrace({
  summary,
  childStatus,
  workspacePath,
}: {
  summary: ResearchTraceSummary;
  childStatus: SubagentChildView["status"];
  workspacePath?: string;
}) {
  return (
    <div className="space-y-1.5">
      <section
        aria-label="研究轨迹"
        className="overflow-hidden rounded-md border border-border/70 bg-muted/10"
      >
        <div className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs">
          <BookOpenCheck className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="font-medium text-foreground/85">研究轨迹</span>
          <span className="ml-auto font-mono text-[10px] text-muted-foreground">
            {summary.calls.length} 次调用
          </span>
        </div>
        <div className="grid grid-cols-3 divide-x divide-border/60 border-t border-border/60">
          <ResearchStage
            icon={<Search className="h-3 w-3" />}
            label="发现"
            value={`${summary.completedSearches} 次搜索`}
          />
          <ResearchStage
            icon={<BookOpenCheck className="h-3 w-3" />}
            label="核验"
            value={`${summary.verifiedSources} 个已核验来源`}
            detail={`${summary.completedFetches} 次抓取`}
          />
          <ResearchStage
            icon={<Send className="h-3 w-3" />}
            label="提交"
            value={submissionLabel(summary.submission, childStatus)}
          />
        </div>
        {(summary.skippedCalls > 0 || summary.failedCalls > 0) && (
          <div className="flex flex-wrap items-center gap-2 border-t border-border/60 px-2.5 py-1.5 text-[10px]">
            {summary.skippedCalls > 0 && (
              <span className="text-muted-foreground">
                {summary.skippedCalls} 次阶段切换
              </span>
            )}
            {summary.failedCalls > 0 && (
              <span className="flex items-center gap-1 text-red-400">
                <CircleAlert className="h-3 w-3" />
                {summary.failedCalls} 次失败
              </span>
            )}
          </div>
        )}
      </section>

      <details className="group overflow-hidden rounded-md border border-border/50 bg-background/30">
        <summary className="flex cursor-pointer list-none items-center gap-1.5 px-2 py-1.5 text-xs text-muted-foreground hover:bg-accent/30 [&::-webkit-details-marker]:hidden">
          <ChevronRight className="h-3.5 w-3.5 transition-transform group-open:rotate-90" />
          <span>研究调用明细</span>
          <span className="ml-auto font-mono text-[10px]">
            {summary.calls.length} 次
          </span>
        </summary>
        <div className="space-y-1 border-t border-border/50 px-1.5 py-1">
          {summary.calls.map((part) => (
            <TracePart
              key={part.toolCallId}
              part={part}
              workspacePath={workspacePath}
            />
          ))}
        </div>
      </details>
    </div>
  );
}

/** 在所有消息里按 batchId 找到对应的 SubagentMessagePart。 */
function findBatch(
  messages: { parts?: MessagePart[] }[],
  batchId: string,
): SubagentMessagePart | undefined {
  for (const m of messages) {
    const found = m.parts?.find(
      (p): p is SubagentMessagePart =>
        p.type === "subagent" && p.batchId === batchId,
    );
    if (found) return found;
  }
  return undefined;
}

function TracePart({
  part,
  workspacePath,
}: {
  part: MessagePart;
  workspacePath?: string;
}) {
  if (part.type === "text" && part.text) {
    // MessageResponse(Streamdown)带 `size-full`(height:100%)。在定高的
    // overflow-auto 容器里直接渲染会让每段文本撑满高度并向下溢出、压住后续
    // 内容(两层叠加)。包一层 auto 高度的 div,让 100% 解析为内容高度。
    return (
      <div className="text-sm">
        <MessageResponse workspacePath={workspacePath}>
          {part.text}
        </MessageResponse>
      </div>
    );
  }
  if (part.type === "reasoning") {
    return <ReasoningBlock part={part as ReasoningPart} />;
  }
  if (part.type === "tool") {
    const inv = part as ToolPart;
    const resultText =
      typeof inv.result === "string"
        ? inv.result
        : JSON.stringify(inv.result, null, 2);
    return (
      <Tool defaultOpen={false}>
        <ToolHeader toolName={inv.toolName} state={inv.state} />
        <ToolContent>
          <ToolInput input={inv.args} />
          {inv.state === "output-available" && (
            <ToolOutput
              output={
                <pre className="whitespace-pre-wrap break-all font-mono">
                  {resultText}
                </pre>
              }
            />
          )}
          {inv.state === "output-error" && (
            <ToolOutput errorText={resultText} />
          )}
        </ToolContent>
      </Tool>
    );
  }
  return null;
}

export function SubagentTracePanel({
  batchId,
  childTaskId,
  onSelectChild,
  workspacePath,
}: {
  batchId: string;
  childTaskId: string;
  onSelectChild?: (childTaskId: string) => void;
  workspacePath?: string;
}) {
  const { LL } = useI18nContext();
  const { messages } = useChatSessionContext();

  const batch = useMemo(
    () => findBatch(messages, batchId),
    [messages, batchId],
  );
  const child: SubagentChildView | undefined = useMemo(
    () => batch?.children.find((c) => c.childTaskId === childTaskId),
    [batch, childTaskId],
  );

  if (!batch || !child) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        {LL.session_empty()}
      </div>
    );
  }

  const total = fmtTokens(child.usage.totalTokens);
  const parts = child.parts ?? [];
  const researchTrace = summarizeResearchTrace(parts);
  const nonResearchParts = researchTrace
    ? parts.filter((part) => !isResearchTool(part))
    : parts;
  const hasNoUsableResult = child.resultQuality === "no_result";
  const hasPartialUsableResult = child.resultQuality === "usable_partial";

  return (
    <div className="flex h-full flex-col">
      {/* 头部:goal + 状态 + 步数/token/耗时 */}
      <div className="shrink-0 border-b border-border px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-foreground/90">
            {child.goal}
          </span>
          <span className="ml-auto shrink-0">
            <StatusBadge status={getSubagentDisplayStatus(child)} />
          </span>
        </div>
        <div className="mt-1 flex items-center gap-3 text-[10px] text-muted-foreground">
          {child.stepCount > 0 && <span>{child.stepCount} 步</span>}
          {total && <span className="font-mono">{total} tok</span>}
          {child.durationMs != null && (
            <span>{(child.durationMs / 1000).toFixed(1)}s</span>
          )}
        </div>
      </div>

      {/* 兄弟切换 chip:同批次其它子任务一键跳转 */}
      {batch.children.length > 1 && (
        <div className="flex shrink-0 flex-wrap gap-1 border-b border-border px-3 py-1.5">
          {batch.children.map((c) => (
            <button
              key={c.childTaskId}
              type="button"
              onClick={() => onSelectChild?.(c.childTaskId)}
              className={`max-w-[12rem] truncate rounded px-2 py-0.5 text-[10px] ${
                c.childTaskId === childTaskId
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:bg-accent/60"
              }`}
              title={c.goal}
            >
              {c.goal}
            </button>
          ))}
        </div>
      )}

      {/* 过程主体 */}
      <div className="flex-1 space-y-2 overflow-auto px-3 py-2">
        {parts.length === 0 ? (
          <div className="text-xs text-muted-foreground">
            {child.status === "queued"
              ? "等待调度…"
              : child.status === "running"
                ? "等待子 agent 输出…"
                : "无过程记录(可能已重载,仅保留摘要)。"}
          </div>
        ) : null}
        {researchTrace && (
          <ResearchTrace
            summary={researchTrace}
            childStatus={child.status}
            workspacePath={workspacePath}
          />
        )}
        {nonResearchParts.map((p, i) => (
          <TracePart
            // biome-ignore lint/suspicious/noArrayIndexKey: 过程 parts 仅追加、不重排,index 稳定
            key={i}
            part={p}
            workspacePath={workspacePath}
          />
        ))}
        {hasPartialUsableResult && child.status !== "queued" && (
          <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-2 text-xs text-amber-600">
            已有可用证据，但覆盖仍不完整。父 agent
            可采纳已提交结论，并需继续核验剩余缺口。
          </div>
        )}
        {hasNoUsableResult && child.status !== "queued" && (
          <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-2 text-xs text-amber-600">
            未产出可采纳结论。该子 agent 可能只返回了启动摘要、过程说明或在生成
            RESULT_JSON 之前被截断。
          </div>
        )}
        {/* 摘要仅在没有过程 parts 时作为兜底展示(parts 本身即子 agent 的
            完整输出,summary 是它的截断副本——两者同时渲染会内容重复)。 */}
        {parts.length === 0 &&
          child.summary &&
          child.status !== "queued" &&
          child.status !== "running" && (
            <div className="mt-3 rounded-md border border-border bg-background/40 p-2 text-xs">
              <div className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                摘要
              </div>
              <div className="whitespace-pre-wrap text-foreground/80">
                {child.summary}
              </div>
            </div>
          )}
        {child.error && (
          <div className="mt-2 whitespace-pre-wrap text-xs text-red-400">
            {child.error}
          </div>
        )}
      </div>
    </div>
  );
}
