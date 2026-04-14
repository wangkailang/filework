import {
  AlertTriangle,
  CopyIcon,
  History,
  Loader2,
  MessageSquarePlus,
  RefreshCw,
  Settings,
  Sparkles,
  Zap,
} from "lucide-react";
import { useState } from "react";
import {
  Confirmation,
  ConfirmationAccepted,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationRejected,
  ConfirmationRequest,
} from "../ai-elements/confirmation";
import {
  Conversation,
  ConversationContent,
  ConversationDownload,
  ConversationEmptyState,
  ConversationScrollButton,
} from "../ai-elements/conversation";
import {
  Message,
  MessageAction,
  MessageActions,
  MessageContent,
  MessageResponse,
} from "../ai-elements/message";
import { PlanViewer } from "../ai-elements/plan-viewer";
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
} from "../ai-elements/prompt-input";
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from "../ai-elements/tool";
import { migrateToParts } from "./helpers";
import { ModelSelector } from "./ModelSelector";
import { SessionList } from "./SessionList";
import { SkillApprovalDialog } from "./SkillApprovalDialog";
import { SkillMenu } from "./SkillMenu";
import type { ErrorPart, MessagePart, PlanMessagePart, ToolPart, UsagePart } from "./types";
import { useChatSession } from "./useChatSession";

const formatTokens = (n: number | null): string => {
  if (n == null) return "-";
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
};

const ERROR_TYPE_LABELS: Record<string, { label: string; hint: string }> = {
  auth: { label: "认证失败", hint: "API 密钥无效或已过期，请在设置中检查配置" },
  billing: {
    label: "余额不足",
    hint: "API 账户余额不足，请前往对应平台充值后重试",
  },
  rate_limit: {
    label: "频率超限",
    hint: "请求频率过高，已自动重试但仍然失败",
  },
  context_overflow: {
    label: "上下文过长",
    hint: "对话过长，建议开启新对话",
  },
  server_error: { label: "服务不可用", hint: "服务端暂时不可用，请稍后重试" },
  timeout: { label: "请求超时", hint: "连接超时，请稍后重试" },
};

const RETRY_TYPE_LABELS: Record<string, string> = {
  rate_limit: "频率限制",
  context_overflow: "上下文压缩",
  server_error: "服务错误",
  timeout: "连接超时",
};

const suggestions = [
  "帮我整理这个目录的文件，按类型分类",
  "分析这个目录的内容，生成一份报告",
  "找出所有重复的文件",
  "统计各类型文件的数量和大小",
];

export const ChatPanel = ({ workspacePath }: { workspacePath: string }) => {
  const [showHistory, setShowHistory] = useState(false);
  const chat = useChatSession(workspacePath);

  // ---------------------------------------------------------------------------
  // Render helpers
  // ---------------------------------------------------------------------------
  const renderToolPart = (inv: ToolPart) => (
    <Tool
      key={inv.toolCallId}
      defaultOpen={inv.state === "output-available"}
      forceOpen={inv.approval?.state === "approval-requested"}
    >
      <ToolHeader toolName={inv.toolName} state={inv.state} />
      <ToolContent>
        <ToolInput input={inv.args} />
        {inv.approval && (
          <div className="px-3 py-2 border-b border-border">
            <Confirmation state={inv.approval.state}>
              {inv.approval.state === "approval-requested" && (
                <>
                  <ConfirmationRequest>
                    {inv.approval.description}
                  </ConfirmationRequest>
                  <ConfirmationActions>
                    <ConfirmationAction
                      variant="outline"
                      onClick={() => chat.handleApproval(inv.toolCallId, false)}
                    >
                      拒绝
                    </ConfirmationAction>
                    <ConfirmationAction
                      variant="default"
                      onClick={() => chat.handleApproval(inv.toolCallId, true)}
                    >
                      批准
                    </ConfirmationAction>
                  </ConfirmationActions>
                </>
              )}
              {inv.approval.state === "approval-accepted" && (
                <ConfirmationAccepted>已批准执行</ConfirmationAccepted>
              )}
              {inv.approval.state === "approval-rejected" && (
                <ConfirmationRejected>已拒绝执行</ConfirmationRejected>
              )}
            </Confirmation>
          </div>
        )}
        {inv.state === "output-available" && (
          <ToolOutput
            output={
              <pre className="font-mono whitespace-pre-wrap break-all">
                {typeof inv.result === "string"
                  ? inv.result
                  : JSON.stringify(inv.result, null, 2)}
              </pre>
            }
          />
        )}
      </ToolContent>
    </Tool>
  );

  const renderAssistantParts = (parts: MessagePart[]) => {
    const textKeyCounts = new Map<string, number>();
    return parts.map((part) => {
      if (part.type === "text" && part.text) {
        const baseKey = `text-${part.text}`;
        const keyCount = (textKeyCounts.get(baseKey) ?? 0) + 1;
        textKeyCounts.set(baseKey, keyCount);
        return (
          <MessageResponse key={`${baseKey}-${keyCount}`}>
            {part.text}
          </MessageResponse>
        );
      }
      if (part.type === "tool") {
        return renderToolPart(part);
      }
      if (part.type === "plan") {
        const planPart = part as PlanMessagePart;
        return (
          <PlanViewer
            key={`plan-${planPart.plan.id}`}
            plan={planPart.plan}
            onApprove={
              planPart.plan.status === "draft"
                ? () => chat.handleApprovePlan(planPart.plan.id)
                : undefined
            }
            onReject={
              planPart.plan.status === "draft"
                ? () => chat.handleRejectPlan(planPart.plan.id)
                : undefined
            }
            onCancel={
              planPart.plan.status === "executing" ||
              planPart.plan.status === "approved"
                ? () => chat.handleCancelPlan(planPart.plan.id)
                : undefined
            }
          />
        );
      }
      if (part.type === "usage") {
        const u = part as UsagePart;
        return (
          <div
            key="usage"
            className="flex items-center gap-3 py-1 text-xs text-muted-foreground"
          >
            <span className="inline-flex items-center gap-1">
              <Zap className="w-3 h-3" />
              {formatTokens(u.inputTokens)} in / {formatTokens(u.outputTokens)} out
            </span>
            {u.modelId && (
              <span className="opacity-60">{u.modelId}</span>
            )}
          </div>
        );
      }
      if (part.type === "error") {
        const errPart = part as ErrorPart;
        const labels = errPart.errorType
          ? ERROR_TYPE_LABELS[errPart.errorType]
          : undefined;
        return (
          <div
            key={`error-${errPart.message}`}
            className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 my-1"
          >
            <div className="flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <div className="text-sm text-destructive font-medium">
                  {labels ? labels.label : "出错了"}
                </div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  {labels ? labels.hint : errPart.message}
                </div>
                <div className="flex items-center gap-2 mt-2">
                  {(errPart.errorType === "server_error" ||
                    errPart.errorType === "timeout" ||
                    errPart.errorType === "rate_limit" ||
                    !errPart.errorType ||
                    errPart.errorType === "unknown") && (
                    <button
                      type="button"
                      onClick={() => {
                        const lastUser = [...chat.messages]
                          .reverse()
                          .find((m) => m.role === "user");
                        if (lastUser) {
                          chat.handleSubmit({ text: lastUser.content });
                        }
                      }}
                      className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md border border-border hover:bg-accent transition-colors"
                    >
                      <RefreshCw className="w-3 h-3" />
                      重试
                    </button>
                  )}
                  {(errPart.errorType === "auth" ||
                    errPart.errorType === "billing") && (
                    <button
                      type="button"
                      onClick={() => {
                        window.dispatchEvent(
                          new CustomEvent("filework:open-settings", {
                            detail: { tab: "llm" },
                          }),
                        );
                      }}
                      className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md border border-border hover:bg-accent transition-colors"
                    >
                      <Settings className="w-3 h-3" />
                      检查配置
                    </button>
                  )}
                  {errPart.errorType === "context_overflow" && (
                    <button
                      type="button"
                      onClick={chat.handleNewChat}
                      className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md border border-border hover:bg-accent transition-colors"
                    >
                      新对话
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        );
      }
      return null;
    });
  };

  const hasMessages = chat.messages.length > 0;
  const hasSessions = chat.sessions.length > 0;

  // ---------------------------------------------------------------------------
  // JSX
  // ---------------------------------------------------------------------------
  return (
    <div className="relative flex flex-col h-full">
      {showHistory && (
        <SessionList
          sessions={chat.sessions}
          activeId={chat.activeSessionId}
          onSelect={chat.handleSelectSession}
          onDelete={chat.handleDeleteSession}
          onClose={() => setShowHistory(false)}
        />
      )}

      {(hasMessages || hasSessions) && (
        <div className="flex items-center justify-between px-4 py-2 border-b border-border">
          <button
            type="button"
            onClick={() => setShowHistory(true)}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <History className="size-3.5" />
            <span>
              历史对话{hasSessions ? ` (${chat.sessions.length})` : ""}
            </span>
          </button>
          <button
            type="button"
            onClick={chat.handleNewChat}
            disabled={chat.isLoading}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
          >
            <MessageSquarePlus className="size-3.5" />
            <span>新对话</span>
          </button>
        </div>
      )}

      <Conversation className="group">
        <ConversationContent>
          {!hasMessages ? (
            <ConversationEmptyState
              title="有什么可以帮你的？"
              description="告诉我你想对这个目录做什么"
            >
              <div className="grid grid-cols-2 gap-2 max-w-lg w-full">
                {suggestions.map((suggestion) => (
                  <button
                    key={suggestion}
                    type="button"
                    onClick={() => chat.setInput(suggestion)}
                    className="text-left text-sm px-3 py-2 rounded-lg border border-border hover:bg-accent transition-colors text-muted-foreground hover:text-foreground"
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            </ConversationEmptyState>
          ) : (
            <>
              {chat.messages.map((msg, index) => (
                <div key={msg.id}>
                  <Message from={msg.role}>
                    <MessageContent>
                      {msg.role === "assistant"
                        ? renderAssistantParts(msg.parts ?? migrateToParts(msg))
                        : msg.content}
                    </MessageContent>
                  </Message>
                  {msg.role === "assistant" &&
                    index === chat.messages.length - 1 && (
                      <MessageActions>
                        <MessageAction
                          onClick={() =>
                            navigator.clipboard.writeText(msg.content)
                          }
                          label="Copy"
                        >
                          <CopyIcon className="size-3" />
                        </MessageAction>
                      </MessageActions>
                    )}
                </div>
              ))}
              {chat.isLoading &&
                chat.messages[chat.messages.length - 1]?.content === "" &&
                !chat.messages[chat.messages.length - 1]?.parts?.length && (
                  <div className="flex items-center gap-2 px-4 py-2 text-muted-foreground">
                    {chat.retryInfo ? (
                      <>
                        <RefreshCw className="w-4 h-4 animate-spin" />
                        <span className="text-sm">
                          正在重试 ({chat.retryInfo.attempt}/
                          {chat.retryInfo.maxRetries})...{" "}
                          <span className="text-xs opacity-75">
                            {RETRY_TYPE_LABELS[chat.retryInfo.type] ??
                              chat.retryInfo.type}
                          </span>
                        </span>
                      </>
                    ) : (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin" />
                        <span className="text-sm">
                          {chat.isPlanGenerating
                            ? "正在分析任务，生成执行计划..."
                            : "思考中..."}
                        </span>
                      </>
                    )}
                    {chat.activeSkill && (
                      <span className="inline-flex items-center gap-1 ml-2 px-2 py-0.5 text-xs rounded-full bg-primary/10 text-primary">
                        <Sparkles className="w-3 h-3" />
                        {chat.activeSkill.skillName}
                        <span className="text-muted-foreground">
                          ({chat.activeSkill.source})
                        </span>
                      </span>
                    )}
                  </div>
                )}
              {chat.activeSkill &&
                chat.isLoading &&
                (chat.messages[chat.messages.length - 1]?.content !== "" ||
                  (chat.messages[chat.messages.length - 1]?.parts?.length ??
                    0) > 0) && (
                  <div className="flex items-center gap-1.5 px-4 py-1">
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded-full bg-primary/10 text-primary">
                      <Sparkles className="w-3 h-3" />
                      {chat.activeSkill.skillName}
                      <span className="text-muted-foreground">
                        ({chat.activeSkill.source})
                      </span>
                    </span>
                  </div>
                )}

              {/* Fallback error banner — shown when lastError is set but the
                  error part was not attached to any message (e.g. race condition
                  between stream-start and stream-error). */}
              {!chat.isLoading && chat.lastError && (() => {
                const lastMsg = chat.messages[chat.messages.length - 1];
                const hasInlineError = lastMsg?.parts?.some(
                  (p) => p.type === "error",
                );
                if (hasInlineError) return null;
                const labels = chat.lastError.type
                  ? ERROR_TYPE_LABELS[chat.lastError.type]
                  : undefined;
                return (
                  <div className="mx-4 my-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
                    <div className="flex items-start gap-2">
                      <AlertTriangle className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm text-destructive font-medium">
                          {labels ? labels.label : "出错了"}
                        </div>
                        <div className="text-xs text-muted-foreground mt-0.5">
                          {labels ? labels.hint : chat.lastError.message}
                        </div>
                        <div className="flex items-center gap-2 mt-2">
                          <button
                            type="button"
                            onClick={() => {
                              const lastUser = [...chat.messages]
                                .reverse()
                                .find((m) => m.role === "user");
                              if (lastUser) {
                                chat.handleSubmit({ text: lastUser.content });
                              }
                            }}
                            className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md border border-border hover:bg-accent transition-colors"
                          >
                            <RefreshCw className="w-3 h-3" />
                            重试
                          </button>
                          {(chat.lastError.type === "auth" ||
                            chat.lastError.type === "billing") && (
                            <button
                              type="button"
                              onClick={() => {
                                window.dispatchEvent(
                                  new CustomEvent("filework:open-settings", {
                                    detail: { tab: "llm" },
                                  }),
                                );
                              }}
                              className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md border border-border hover:bg-accent transition-colors"
                            >
                              <Settings className="w-3 h-3" />
                              检查配置
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })()}

              {/* Usage info after completion (for current stream before save) */}
              {!chat.isLoading &&
                chat.lastUsage &&
                !chat.messages.some(
                  (m) =>
                    m.role === "assistant" &&
                    m.parts?.some((p) => p.type === "usage"),
                ) && (
                  <div className="flex items-center gap-3 px-4 py-1.5 text-xs text-muted-foreground">
                    <span className="inline-flex items-center gap-1">
                      <Zap className="w-3 h-3" />
                      {formatTokens(chat.lastUsage.inputTokens)} in /{" "}
                      {formatTokens(chat.lastUsage.outputTokens)} out
                    </span>
                    {chat.lastUsage.modelId && (
                      <span className="opacity-60">
                        {chat.lastUsage.modelId}
                      </span>
                    )}
                  </div>
                )}

            </>
          )}
        </ConversationContent>
        {hasMessages && <ConversationDownload messages={chat.messages} />}
        <ConversationScrollButton />
      </Conversation>

      <div className="px-6 py-4">
        <div className="max-w-2xl mx-auto">
          <PromptInput onSubmit={chat.handleSubmit}>
            <PromptInputBody>
              <div className="relative">
                <SkillMenu
                  input={chat.input}
                  onSelect={(cmd) => chat.setInput(cmd)}
                />
                <PromptInputTextarea
                  value={chat.input}
                  onChange={(e) => chat.setInput(e.target.value)}
                  placeholder="告诉我你想做什么... (Enter 发送)"
                />
              </div>
            </PromptInputBody>
            <PromptInputFooter>
              <ModelSelector
                selectedConfigId={chat.selectedLlmConfigId}
                onSelect={chat.setSelectedLlmConfigId}
              />
              <PromptInputSubmit
                disabled={false}
                status={chat.isLoading ? "streaming" : "ready"}
                onStop={chat.handleStopGeneration}
              />
            </PromptInputFooter>
          </PromptInput>
        </div>
      </div>

      {chat.pendingSkillApproval && (
        <SkillApprovalDialog
          data={chat.pendingSkillApproval}
          onRespond={chat.handleSkillApproval}
        />
      )}
    </div>
  );
};
