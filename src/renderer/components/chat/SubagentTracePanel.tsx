// 钻入面板:在 ContextDock 的 subagent 标签里回放单个子 agent 的执行过程。
// 数据来自 chat context 的 messages(随子 agent 流式实时更新),按 batchId 定位
// SubagentMessagePart、childTaskId 定位 child,复用主线程的工具/推理/文本渲染。
import { useMemo } from "react";

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
  const hasNoUsableResult = child.resultQuality === "no_result";

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
        ) : (
          parts.map((p, i) => (
            <TracePart
              // biome-ignore lint/suspicious/noArrayIndexKey: 过程 parts 仅追加、不重排,index 稳定
              key={i}
              part={p}
              workspacePath={workspacePath}
            />
          ))
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
