import {
  AlertTriangle,
  CopyIcon,
  GitBranch,
  History,
  Loader2,
  MessageSquarePlus,
  RefreshCw,
  Settings,
  Sparkles,
  Zap,
} from "lucide-react";
import { useMemo, useState } from "react";
import { useI18nContext } from "../../i18n/i18n-react";
import type { TranslationFunctions } from "../../i18n/i18n-types";
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
import type {
  ErrorPart,
  MessagePart,
  PlanMessagePart,
  RecoveryAction,
  ToolPart,
  UsagePart,
} from "./types";
import { useChatSession } from "./useChatSession";

const formatTokens = (n: number | null): string => {
  if (n == null) return "-";
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
};

const getErrorTypeLabels = (LL: TranslationFunctions): Record<string, { label: string; hint: string }> => ({
  auth: { label: LL.errorType_auth(), hint: LL.errorType_authHint() },
  billing: { label: LL.errorType_billing(), hint: LL.errorType_billingHint() },
  rate_limit: { label: LL.errorType_rateLimit(), hint: LL.errorType_rateLimitHint() },
  context_overflow: { label: LL.errorType_contextOverflow(), hint: LL.errorType_contextOverflowHint() },
  server_error: { label: LL.errorType_serverError(), hint: LL.errorType_serverErrorHint() },
  timeout: { label: LL.errorType_timeout(), hint: LL.errorType_timeoutHint() },
  proxy_intercepted: { label: LL.errorType_proxyIntercepted(), hint: LL.errorType_proxyInterceptedHint() },
});

const getRetryTypeLabels = (LL: TranslationFunctions): Record<string, string> => ({
  rate_limit: LL.retry_rateLimit(),
  context_overflow: LL.retry_contextOverflow(),
  server_error: LL.retry_serverError(),
  timeout: LL.retry_timeout(),
});

/** Fallback recovery actions for errors that don't carry explicit actions (e.g. persisted from older versions) */
const fallbackRecoveryActions = (errorType?: string): RecoveryAction[] => {
  switch (errorType) {
    case "auth":
    case "billing":
      return ["settings"];
    case "context_overflow":
      return ["new_chat"];
    case "timeout":
      return ["retry", "settings"];
    case "proxy_intercepted":
      return ["settings"];
    default:
      return ["retry"];
  }
};

const RECOVERY_ACTION_ICONS: Record<RecoveryAction, typeof RefreshCw> = {
  retry: RefreshCw,
  settings: Settings,
  new_chat: MessageSquarePlus,
};

const getRecoveryLabels = (LL: TranslationFunctions): Record<RecoveryAction, string> => ({
  retry: LL.recovery_retry(),
  settings: LL.recovery_settings(),
  new_chat: LL.recovery_newChat(),
});

const RecoveryButton = ({
  action,
  chat,
}: {
  action: RecoveryAction;
  chat: ReturnType<typeof useChatSession>;
}) => {
  const { LL } = useI18nContext();
  const Icon = RECOVERY_ACTION_ICONS[action];
  const recoveryLabels = useMemo(() => getRecoveryLabels(LL), [LL]);

  const handleClick = () => {
    switch (action) {
      case "retry": {
        const lastUser = [...chat.messages]
          .reverse()
          .find((m) => m.role === "user");
        if (lastUser) chat.handleSubmit({ text: lastUser.content });
        break;
      }
      case "settings":
        window.dispatchEvent(
          new CustomEvent("filework:open-settings", {
            detail: { tab: "llm" },
          }),
        );
        break;
      case "new_chat":
        chat.handleNewChat();
        break;
    }
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md border border-border hover:bg-accent transition-colors"
    >
      <Icon className="w-3 h-3" />
      {recoveryLabels[action]}
    </button>
  );
};

const ErrorBanner = ({
  label,
  hint,
  actions,
  chat,
  className,
}: {
  label: string;
  hint: string;
  actions: RecoveryAction[];
  chat: ReturnType<typeof useChatSession>;
  className?: string;
}) => (
  <div
    className={`rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 ${className ?? ""}`}
  >
    <div className="flex items-start gap-2">
      <AlertTriangle className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <div className="text-sm text-destructive font-medium">{label}</div>
        <div className="text-xs text-muted-foreground mt-0.5">{hint}</div>
        <div className="flex items-center gap-2 mt-2">
          {actions.map((action) => (
            <RecoveryButton key={action} action={action} chat={chat} />
          ))}
        </div>
      </div>
    </div>
  </div>
);

export const ChatPanel = ({ workspacePath }: { workspacePath: string }) => {
  const { LL } = useI18nContext();
  const [showHistory, setShowHistory] = useState(false);
  const chat = useChatSession(workspacePath);

  const ERROR_TYPE_LABELS = useMemo(() => getErrorTypeLabels(LL), [LL]);
  const RETRY_TYPE_LABELS = useMemo(() => getRetryTypeLabels(LL), [LL]);
  const suggestions = [
    LL.suggestion_organize(),
    LL.suggestion_report(),
    LL.suggestion_duplicates(),
    LL.suggestion_stats(),
  ];

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
                      {LL.chat_reject()}
                    </ConfirmationAction>
                    <ConfirmationAction
                      variant="default"
                      onClick={() => chat.handleApproval(inv.toolCallId, true)}
                    >
                      {LL.chat_approve()}
                    </ConfirmationAction>
                  </ConfirmationActions>
                </>
              )}
              {inv.approval.state === "approval-accepted" && (
                <ConfirmationAccepted>{LL.chat_approved()}</ConfirmationAccepted>
              )}
              {inv.approval.state === "approval-rejected" && (
                <ConfirmationRejected>{LL.chat_rejected()}</ConfirmationRejected>
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
            isStalled={chat.isStalled}
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
              {formatTokens(u.inputTokens)} in / {formatTokens(u.outputTokens)}{" "}
              out
            </span>
            {u.modelId && <span className="opacity-60">{u.modelId}</span>}
          </div>
        );
      }
      if (part.type === "error") {
        const errPart = part as ErrorPart;
        const labels = errPart.errorType
          ? ERROR_TYPE_LABELS[errPart.errorType]
          : undefined;
        const actions: RecoveryAction[] =
          errPart.recoveryActions ?? fallbackRecoveryActions(errPart.errorType);
        return (
          <ErrorBanner
            key={`error-${errPart.message}`}
            label={labels ? labels.label : LL.chat_error()}
            hint={labels ? labels.hint : errPart.message}
            actions={actions}
            chat={chat}
            className="my-1"
          />
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
              {LL.session_history()}{hasSessions ? ` (${chat.sessions.length})` : ""}
            </span>
          </button>
          <button
            type="button"
            onClick={chat.handleNewChat}
            disabled={chat.isLoading}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
          >
            <MessageSquarePlus className="size-3.5" />
            <span>{LL.session_newChat()}</span>
          </button>
        </div>
      )}

      <Conversation className="group">
        <ConversationContent>
          {!hasMessages ? (
            <ConversationEmptyState
              title={LL.chat_emptyTitle()}
              description={LL.chat_emptyDescription()}
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
                  {msg.role === "user" && !chat.isLoading && (
                    <MessageActions className="opacity-0 group-hover:opacity-100 transition-opacity justify-end">
                      <MessageAction
                        onClick={() => chat.handleForkSession(msg.id)}
                        label={LL.chat_forkHere()}
                      >
                        <GitBranch className="size-3" />
                      </MessageAction>
                    </MessageActions>
                  )}
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
                          {LL.chat_retrying(String(chat.retryInfo.attempt), String(chat.retryInfo.maxRetries))}{" "}
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
                            ? LL.chat_planGenerating()
                            : LL.chat_thinking()}
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
              {!chat.isLoading &&
                chat.lastError &&
                (() => {
                  const lastMsg = chat.messages[chat.messages.length - 1];
                  const hasInlineError = lastMsg?.parts?.some(
                    (p) => p.type === "error",
                  );
                  if (hasInlineError) return null;
                  const labels = chat.lastError.type
                    ? ERROR_TYPE_LABELS[chat.lastError.type]
                    : undefined;
                  const actions: RecoveryAction[] =
                    (chat.lastError.recoveryActions as
                      | RecoveryAction[]
                      | undefined) ??
                    fallbackRecoveryActions(chat.lastError.type);
                  return (
                    <ErrorBanner
                      label={labels ? labels.label : LL.chat_error()}
                      hint={labels ? labels.hint : chat.lastError.message}
                      actions={actions}
                      chat={chat}
                      className="mx-4 my-2"
                    />
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
                  placeholder={LL.chat_inputPlaceholder()}
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
