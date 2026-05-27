import {
  AlertTriangle,
  Brain,
  CopyIcon,
  GitBranch,
  HelpCircle,
  History,
  Loader2,
  MessageSquarePlus,
  RefreshCw,
  Settings,
  Sparkles,
  Zap,
} from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { useI18nContext } from "../../i18n/i18n-react";
import type { TranslationFunctions } from "../../i18n/i18n-types";
import {
  Confirmation,
  ConfirmationAccepted,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationBatch,
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
import type { ComposerAttachment } from "../ai-elements/prompt-input";
import {
  PromptInput,
  PromptInputAttachButton,
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
import { getToolLabels } from "../ai-elements/tool-labels";
import { toolPresenters } from "../ai-elements/tool-presenters";
import { WorkspaceMemoryModal } from "../settings/WorkspaceMemoryModal";
import { ArticleMetaBar } from "./ArticleMetaBar";
import { AttachmentChips, AttachmentList } from "./AttachmentChips";
import { migrateToParts } from "./helpers";
import { ImageGallery } from "./ImageGallery";
import { MediaImageCard } from "./MediaImageCard";
import { MediaVideoCard } from "./MediaVideoCard";
import { ModelSelector } from "./ModelSelector";
import { ReasoningBlock } from "./ReasoningBlock";
import { SessionList } from "./SessionList";
import { SkillApprovalDialog } from "./SkillApprovalDialog";
import { SkillMenu } from "./SkillMenu";
import type {
  ArticleMetaPart,
  AttachmentPart,
  BatchApprovalEntry,
  BatchApprovalPart,
  ClarificationPart,
  ErrorPart,
  ImageGalleryPart,
  ImagePart,
  MessagePart,
  PlanMessagePart,
  ReasoningPart,
  RecoveryAction,
  ToolApproval,
  ToolPart,
  UsagePart,
  VideoGalleryPart,
  VideoJobPart,
} from "./types";
import { useChatSession } from "./useChatSession";
import { VideoGallery } from "./VideoGallery";

const formatTokens = (n: number | null): string => {
  if (n == null) return "-";
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
};

const renderApprovalRequest = ({
  approval,
  onDecide,
  LL,
}: {
  approval: ToolApproval;
  onDecide: (approved: boolean) => void;
  LL: TranslationFunctions;
}) => (
  <>
    <ConfirmationRequest>{approval.description}</ConfirmationRequest>
    <ConfirmationActions>
      <ConfirmationAction variant="outline" onClick={() => onDecide(false)}>
        {LL.chat_reject()}
      </ConfirmationAction>
      <ConfirmationAction variant="default" onClick={() => onDecide(true)}>
        {LL.chat_approve()}
      </ConfirmationAction>
    </ConfirmationActions>
  </>
);

const getErrorTypeLabels = (
  LL: TranslationFunctions,
): Record<string, { label: string; hint: string }> => ({
  auth: { label: LL.errorType_auth(), hint: LL.errorType_authHint() },
  billing: { label: LL.errorType_billing(), hint: LL.errorType_billingHint() },
  rate_limit: {
    label: LL.errorType_rateLimit(),
    hint: LL.errorType_rateLimitHint(),
  },
  context_overflow: {
    label: LL.errorType_contextOverflow(),
    hint: LL.errorType_contextOverflowHint(),
  },
  server_error: {
    label: LL.errorType_serverError(),
    hint: LL.errorType_serverErrorHint(),
  },
  timeout: { label: LL.errorType_timeout(), hint: LL.errorType_timeoutHint() },
  proxy_intercepted: {
    label: LL.errorType_proxyIntercepted(),
    hint: LL.errorType_proxyInterceptedHint(),
  },
});

const getRetryTypeLabels = (
  LL: TranslationFunctions,
): Record<string, string> => ({
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

const getRecoveryLabels = (
  LL: TranslationFunctions,
): Record<RecoveryAction, string> => ({
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

/**
 * Renders a single clarification prompt — question + multi-choice
 * buttons — and tracks the user's pick locally so the buttons disable
 * the moment a choice is dispatched (no waiting for the IPC round-trip
 * + re-render through the messages array). Once the parent persists
 * `answeredOption` on the part, the persisted value wins and survives
 * re-mounts / session reload.
 */
const ClarificationCard = ({
  part,
  onPick,
  LL,
}: {
  part: ClarificationPart;
  onPick: (opt: string) => Promise<void>;
  LL: TranslationFunctions;
}) => {
  const [localPick, setLocalPick] = useState<string | null>(null);
  const [freeText, setFreeText] = useState("");
  // Persisted answer beats local optimistic state once it lands.
  const picked = part.answeredOption ?? localPick;
  const isAnswered = picked !== null && picked !== undefined;
  const hasOptions = !!part.options && part.options.length > 0;

  const submitFreeText = () => {
    const text = freeText.trim();
    if (!text || isAnswered) return;
    setLocalPick(text);
    void onPick(text);
  };

  return (
    <div className="rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 my-1">
      <div className="flex items-start gap-2">
        <HelpCircle className="w-4 h-4 text-primary shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="text-xs font-medium text-primary">
            {LL.clarification_title()}
          </div>
          <div className="text-sm text-foreground mt-0.5">{part.question}</div>
          {hasOptions && (
            <div className="flex flex-wrap gap-1.5 mt-2">
              {part.options?.map((opt) => {
                const selected = picked === opt;
                return (
                  <button
                    key={opt}
                    type="button"
                    disabled={isAnswered}
                    onClick={() => {
                      setLocalPick(opt);
                      void onPick(opt);
                    }}
                    className={
                      selected
                        ? "inline-flex items-center px-2.5 py-1 text-xs rounded-md border border-primary bg-primary/15 text-primary cursor-default"
                        : isAnswered
                          ? "inline-flex items-center px-2.5 py-1 text-xs rounded-md border border-border text-muted-foreground opacity-60 cursor-default"
                          : "inline-flex items-center px-2.5 py-1 text-xs rounded-md border border-border hover:bg-accent hover:text-foreground transition-colors"
                    }
                  >
                    {opt}
                  </button>
                );
              })}
            </div>
          )}
          {/* Free-text reply — only when the model didn't supply options.
              Without this the agent loop would deadlock on a bare
              question (the askClarification tool BLOCKS until answered). */}
          {!hasOptions && !isAnswered && (
            <div className="mt-2 flex items-end gap-2">
              <textarea
                value={freeText}
                onChange={(e) => setFreeText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    submitFreeText();
                  }
                }}
                rows={2}
                placeholder="输入回复…"
                className="flex-1 resize-none rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              />
              <button
                type="button"
                onClick={submitFreeText}
                disabled={!freeText.trim()}
                className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
              >
                发送
              </button>
            </div>
          )}
          {!hasOptions && isAnswered && (
            <div className="mt-2 rounded-md border border-border bg-background px-2 py-1 text-xs text-muted-foreground">
              {picked}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export const ChatPanel = ({
  workspacePath,
  workspaceRefJson,
}: {
  workspacePath: string;
  workspaceRefJson?: string;
}) => {
  const { LL } = useI18nContext();
  const [showHistory, setShowHistory] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const chat = useChatSession(workspacePath, workspaceRefJson);

  // Composer-side pending attachments — lifted out of PromptInput so the
  // drag-drop overlay (sibling DOM) and the file picker feed the same
  // source of truth. PromptInput receives `attachments` as a controlled
  // prop and clears via onAttachmentsChange after a successful submit.
  const [pendingAttachments, setPendingAttachments] = useState<
    ComposerAttachment[]
  >([]);
  const [isDragging, setIsDragging] = useState(false);
  // Tracks nested onDragEnter/Leave fires so the overlay clears only
  // when the cursor truly leaves the panel (children re-fire on hover).
  const dragDepth = useRef(0);

  const attachSourcePath = async (
    sourcePath: string,
    originalName?: string,
  ): Promise<ComposerAttachment | null> => {
    // If no active session yet, drop into a generic `draft/` folder under
    // attachments root. The file path is immutable once written, so we
    // don't need to migrate when the session id is eventually minted.
    const sessionId = chat.activeSessionId ?? "draft";
    const result = await window.filework.chatAttachFile({
      sessionId,
      sourcePath,
      originalName,
    });
    if (result && typeof result === "object" && "error" in result) {
      chat.setLastError({ message: `Attach failed: ${result.error}` });
      return null;
    }
    return result;
  };

  const attachMany = async (
    sources: Array<{ path: string; name?: string }>,
  ) => {
    const results = await Promise.all(
      sources.map((s) => attachSourcePath(s.path, s.name)),
    );
    const ok = results.filter((r): r is ComposerAttachment => r !== null);
    if (ok.length > 0) setPendingAttachments((prev) => [...prev, ...ok]);
  };

  // Mirror the main-process 25 MB cap. Checked against `blob.size` BEFORE
  // calling `arrayBuffer()` so a huge clipboard image doesn't decode in
  // the renderer (double-allocates: ArrayBuffer + Uint8Array view) and
  // get IPC-cloned only to be rejected on the other side.
  const MAX_PASTE_BYTES = 25 * 1024 * 1024;

  const attachBlob = async (
    blob: Blob,
    name?: string,
  ): Promise<ComposerAttachment | null> => {
    if (blob.size > MAX_PASTE_BYTES) {
      chat.setLastError({
        message: `Attach failed: File too large (${(blob.size / 1024 / 1024).toFixed(1)} MB > 25 MB)`,
      });
      return null;
    }
    const sessionId = chat.activeSessionId ?? "draft";
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const result = await window.filework.chatAttachBlob({
      sessionId,
      bytes,
      mimeType: blob.type,
      name,
    });
    if (result && typeof result === "object" && "error" in result) {
      chat.setLastError({ message: `Attach failed: ${result.error}` });
      return null;
    }
    return result;
  };

  const onPaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items || items.length === 0) return;
    const blobs: Array<{ blob: Blob; name?: string }> = [];
    for (const item of Array.from(items)) {
      if (item.kind !== "file") continue;
      const isImage = item.type.startsWith("image/");
      const isPdf = item.type === "application/pdf";
      if (!isImage && !isPdf) continue;
      const f = item.getAsFile();
      if (f) blobs.push({ blob: f, name: f.name || undefined });
    }
    if (blobs.length === 0) return;
    // Consumed paste — stop the textarea from receiving binary garbage as text.
    e.preventDefault();
    // `preventDefault` has already fired, so any silent rejection past
    // this point leaves the textarea blank with no user feedback —
    // funnel errors into chat.setLastError instead of dropping them.
    try {
      const results = await Promise.all(
        blobs.map(({ blob, name }) => attachBlob(blob, name)),
      );
      const ok = results.filter((r): r is ComposerAttachment => r !== null);
      if (ok.length > 0) setPendingAttachments((prev) => [...prev, ...ok]);
    } catch (err) {
      chat.setLastError({
        message: `Paste failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  };

  const handlePickFiles = async () => {
    const paths = await window.filework.openFiles();
    await attachMany(paths.map((p) => ({ path: p })));
  };

  const handleRemoveAttachment = (id: string) => {
    setPendingAttachments((prev) => prev.filter((a) => a.attachmentId !== id));
  };

  const onDragEnter = (e: React.DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    dragDepth.current += 1;
    setIsDragging(true);
  };
  const onDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  };
  const onDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setIsDragging(false);
  };
  const onDrop = async (e: React.DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    dragDepth.current = 0;
    setIsDragging(false);
    const sources = Array.from(e.dataTransfer.files)
      .map((file) => ({
        path: window.filework.getPathForFile(file),
        name: file.name,
      }))
      .filter((s) => Boolean(s.path));
    await attachMany(sources);
  };

  const ERROR_TYPE_LABELS = useMemo(() => getErrorTypeLabels(LL), [LL]);
  const RETRY_TYPE_LABELS = useMemo(() => getRetryTypeLabels(LL), [LL]);
  const toolLabels = useMemo(() => getToolLabels(LL), [LL]);
  const suggestions = [
    LL.suggestion_organize(),
    LL.suggestion_report(),
    LL.suggestion_duplicates(),
    LL.suggestion_stats(),
  ];

  // ---------------------------------------------------------------------------
  // Render helpers
  // ---------------------------------------------------------------------------
  const renderToolPart = (inv: ToolPart) => {
    const presenter = toolPresenters[inv.toolName];
    const presenterCtx = {
      LL,
      workspacePath,
      toolCallId: inv.toolCallId,
      previewSnapshot: inv.previewSnapshot,
    };
    const summary = presenter?.summary?.(
      inv.args,
      inv.result,
      inv.state,
      presenterCtx,
    );
    const customInput = presenter?.input?.(inv.args, presenterCtx);
    const customOutput =
      inv.state === "output-available"
        ? presenter?.output?.(inv.result, inv.args, inv.state, presenterCtx)
        : null;

    return (
      <Tool
        key={inv.toolCallId}
        defaultOpen={inv.state === "output-error"}
        forceOpen={inv.approval?.state === "approval-requested"}
      >
        <ToolHeader
          toolName={inv.toolName}
          state={inv.state}
          summary={summary}
        />
        <ToolContent>
          {customInput ?? <ToolInput input={inv.args} />}
          {inv.approval && (
            <div className="px-3 py-2 border-b border-border">
              <Confirmation state={inv.approval.state}>
                {inv.approval.state === "approval-requested" &&
                  renderApprovalRequest({
                    approval: inv.approval,
                    onDecide: (approved) =>
                      chat.handleApproval(inv.toolCallId, approved),
                    LL,
                  })}
                {inv.approval.state === "approval-accepted" && (
                  <ConfirmationAccepted>
                    {LL.chat_approved()}
                  </ConfirmationAccepted>
                )}
                {inv.approval.state === "approval-rejected" && (
                  <ConfirmationRejected>
                    {LL.chat_rejected()}
                  </ConfirmationRejected>
                )}
              </Confirmation>
            </div>
          )}
          {inv.state === "output-available" &&
            (customOutput ? (
              <ToolOutput output={customOutput} />
            ) : (
              <ToolOutput
                output={
                  <pre className="font-mono whitespace-pre-wrap break-all">
                    {typeof inv.result === "string"
                      ? inv.result
                      : JSON.stringify(inv.result, null, 2)}
                  </pre>
                }
              />
            ))}
          {inv.state === "output-error" && (
            <ToolOutput
              errorText={
                typeof inv.result === "string"
                  ? inv.result
                  : JSON.stringify(inv.result, null, 2)
              }
            />
          )}
        </ToolContent>
      </Tool>
    );
  };

  const TOOL_GROUP_THRESHOLD = 3;

  type ToolGroupUnit = {
    type: "tool-group";
    items: MessagePart[];
    toolName: string;
    toolCount: number;
  };

  const renderToolGroup = (unit: ToolGroupUnit) => {
    const { items, toolName, toolCount } = unit;
    const label = toolLabels[toolName] || toolName;
    const summary = LL.tool_summary_group_label(toolCount, label);
    const head = items.find((p) => p.type === "tool") as ToolPart | undefined;
    let groupReasoningIdx = 0;
    return (
      <Tool key={`group-${head?.toolCallId ?? toolName}`} defaultOpen={false}>
        <ToolHeader
          toolName={toolName}
          state="output-available"
          summary={summary}
        />
        <ToolContent>
          <div className="divide-y divide-border">
            {items.map((p) => {
              if (p.type === "reasoning") {
                groupReasoningIdx++;
                return (
                  <div key={`g-reasoning-${groupReasoningIdx}`} className="p-2">
                    <ReasoningBlock part={p as ReasoningPart} />
                  </div>
                );
              }
              const inv = p as ToolPart;
              return (
                <div key={inv.toolCallId} className="p-2">
                  {renderToolPart(inv)}
                </div>
              );
            })}
          </div>
        </ToolContent>
      </Tool>
    );
  };

  type RenderUnit = MessagePart | ToolGroupUnit;

  // 把连续的同名工具调用聚成一组。reasoning 不打断连续段(会被并入组内,
  // 在展开时按原顺序穿插显示),这样"思考→扫描→思考→扫描…"的交错流也能折叠。
  const groupConsecutiveTools = (parts: MessagePart[]): RenderUnit[] => {
    const out: RenderUnit[] = [];
    let buf: MessagePart[] = [];
    let groupToolName: string | null = null;

    const emitEach = (items: MessagePart[]) => {
      for (const p of items) out.push(p);
    };

    const flush = () => {
      if (buf.length === 0) return;
      const firstToolIdx = buf.findIndex((p) => p.type === "tool");
      if (firstToolIdx === -1) {
        // 缓冲里只有 reasoning,没有工具:原样输出
        emitEach(buf);
        buf = [];
        groupToolName = null;
        return;
      }
      let lastToolIdx = firstToolIdx;
      for (let i = buf.length - 1; i > firstToolIdx; i--) {
        if (buf[i]?.type === "tool") {
          lastToolIdx = i;
          break;
        }
      }
      // 把首个工具之前 / 末个工具之后的 reasoning 留在组外
      // (它们通常分别属于"开场思考"和"最终回答前的思考")
      const leading = buf.slice(0, firstToolIdx);
      const core = buf.slice(firstToolIdx, lastToolIdx + 1);
      const trailing = buf.slice(lastToolIdx + 1);
      const toolCount = core.filter((p) => p.type === "tool").length;

      emitEach(leading);
      if (toolCount >= TOOL_GROUP_THRESHOLD && groupToolName) {
        out.push({
          type: "tool-group",
          items: core,
          toolName: groupToolName,
          toolCount,
        });
      } else {
        emitEach(core);
      }
      emitEach(trailing);

      buf = [];
      groupToolName = null;
    };

    for (const part of parts) {
      if (part.type === "reasoning") {
        // reasoning 不打断同名工具的连续段
        buf.push(part);
        continue;
      }
      if (part.type === "tool") {
        const inv = part as ToolPart;
        const groupable = !inv.approval && inv.state !== "output-error";
        if (!groupable) {
          flush();
          out.push(part);
          continue;
        }
        if (groupToolName === null) {
          groupToolName = inv.toolName;
          buf.push(part);
        } else if (groupToolName === inv.toolName) {
          buf.push(part);
        } else {
          flush();
          groupToolName = inv.toolName;
          buf.push(part);
        }
        continue;
      }
      // 其它部件(text / plan / usage / …)打断分组
      flush();
      out.push(part);
    }
    flush();
    return out;
  };

  const renderAssistantParts = (parts: MessagePart[]) => {
    const textKeyCounts = new Map<string, number>();
    let reasoningIdx = 0;

    // 把多张「同名工具 + 待批准」的批量卡合并成一张:模型可能分多步顺序
    // 发起删除,后端会拆成多个批次,这里按 toolName 收集所有 batchId 与条目,
    // 只在第一张的位置渲染合并卡,其余跳过。批准/拒绝时对全部 batchId 生效。
    const pendingBatchGroups = new Map<
      string,
      {
        batchIds: string[];
        entries: BatchApprovalEntry[];
        firstBatchId: string;
      }
    >();
    // 待批准批次已在审批卡里逐条列出的 toolCallId——对应的「执行中」工具行
    // 会被隐藏,避免审批阶段同一批删除既出现在卡片里又刷出一堆独立行。
    const pendingBatchToolCallIds = new Set<string>();
    for (const p of parts) {
      if (p.type !== "batch-approval" || p.state !== "approval-requested")
        continue;
      const bp = p as BatchApprovalPart;
      for (const e of bp.entries) pendingBatchToolCallIds.add(e.toolCallId);
      const g = pendingBatchGroups.get(bp.toolName);
      if (g) {
        g.batchIds.push(bp.batchId);
        g.entries.push(...bp.entries);
      } else {
        pendingBatchGroups.set(bp.toolName, {
          batchIds: [bp.batchId],
          entries: [...bp.entries],
          firstBatchId: bp.batchId,
        });
      }
    }

    // 隐藏「正等待批准」且已被审批卡收录的工具行;批准后状态转为
    // output-available,会重新显示并按 groupConsecutiveTools 正常折叠。
    const visibleParts =
      pendingBatchToolCallIds.size === 0
        ? parts
        : parts.filter((p) => {
            if (p.type !== "tool") return true;
            const tp = p as ToolPart;
            const awaiting =
              tp.state === "input-available" || tp.state === "input-streaming";
            return !(awaiting && pendingBatchToolCallIds.has(tp.toolCallId));
          });

    return groupConsecutiveTools(visibleParts).map((part) => {
      if (part.type === "tool-group") {
        return renderToolGroup(part);
      }
      if (part.type === "reasoning") {
        reasoningIdx++;
        return (
          <ReasoningBlock
            key={`reasoning-${reasoningIdx}`}
            part={part as ReasoningPart}
          />
        );
      }
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
      if (part.type === "image") {
        const ip = part as ImagePart;
        return <MediaImageCard key={`image-${ip.imageId}`} part={ip} />;
      }
      if (part.type === "image-gallery") {
        const gp = part as ImageGalleryPart;
        const firstUrl = gp.images[0]?.url ?? "empty";
        return (
          <ImageGallery
            key={`gallery-${gp.source}-${gp.images.length}-${firstUrl}`}
            part={gp}
          />
        );
      }
      if (part.type === "video-gallery") {
        const vg = part as VideoGalleryPart;
        const firstUrl = vg.videos[0]?.url ?? "empty";
        return (
          <VideoGallery
            key={`video-gallery-${vg.videos.length}-${firstUrl}`}
            part={vg}
          />
        );
      }
      if (part.type === "article-meta") {
        const ap = part as ArticleMetaPart;
        const key = `article-meta-${ap.pageUrl ?? ""}-${ap.meta.publishedTime ?? ""}-${ap.meta.byline ?? ""}-${ap.meta.siteName ?? ""}`;
        return <ArticleMetaBar key={key} part={ap} />;
      }
      if (part.type === "video-job") {
        const vp = part as VideoJobPart;
        return <MediaVideoCard key={`video-${vp.jobId}`} part={vp} />;
      }
      if (part.type === "batch-approval") {
        const bp = part as BatchApprovalPart;
        if (bp.state === "approval-requested") {
          const group = pendingBatchGroups.get(bp.toolName);
          // 只在该组第一张的位置渲染合并卡,其余跳过,避免出现多张
          if (!group || group.firstBatchId !== bp.batchId) return null;
          const { batchIds, entries } = group;
          return (
            <ConfirmationBatch
              key={`batch-${bp.batchId}`}
              state="approval-requested"
              toolName={bp.toolName}
              entries={entries}
              onApprove={(remember) => {
                for (const id of batchIds)
                  chat.handleBatchApproval(id, true, remember);
              }}
              onDeny={() => {
                for (const id of batchIds) chat.handleBatchApproval(id, false);
              }}
              className="my-1"
            />
          );
        }
        return (
          <ConfirmationBatch
            key={`batch-${bp.batchId}`}
            state={bp.state}
            toolName={bp.toolName}
            entries={bp.entries}
            onApprove={(remember) =>
              chat.handleBatchApproval(bp.batchId, true, remember)
            }
            onDeny={() => chat.handleBatchApproval(bp.batchId, false)}
            className="my-1"
          />
        );
      }
      if (part.type === "clarification") {
        const cp = part as ClarificationPart;
        // Keying by clarificationId (when present) lets React keep
        // separate cards when the agent emits multiple clarifications
        // with identical question text. Falls back to question for
        // legacy parts persisted before the field existed.
        return (
          <ClarificationCard
            key={`clarify-${cp.clarificationId ?? cp.question}`}
            part={cp}
            onPick={(opt) =>
              chat.handleClarificationPick(cp.clarificationId, opt)
            }
            LL={LL}
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
    <section
      aria-label="Chat panel"
      className="relative flex flex-col h-full"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {isDragging && (
        <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center bg-primary/5 backdrop-blur-sm">
          <div className="rounded-xl border-2 border-dashed border-primary bg-background/80 px-6 py-4 text-sm font-medium text-primary shadow-lg">
            Drop files to attach
          </div>
        </div>
      )}
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
              {LL.session_history()}
              {hasSessions ? ` (${chat.sessions.length})` : ""}
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

      <WorkspaceMemoryModal
        open={memoryOpen}
        onClose={() => setMemoryOpen(false)}
        workspacePath={workspacePath}
      />

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
              {chat.messages.map((msg, index) => {
                const userAttachments =
                  msg.role === "user"
                    ? ((msg.parts?.filter((p) => p.type === "attachment") as
                        | AttachmentPart[]
                        | undefined) ?? [])
                    : [];
                return (
                  <div key={msg.id}>
                    <Message from={msg.role}>
                      <MessageContent>
                        {msg.role === "assistant" ? (
                          renderAssistantParts(msg.parts ?? migrateToParts(msg))
                        ) : (
                          <>
                            {userAttachments.length > 0 && (
                              <AttachmentList attachments={userAttachments} />
                            )}
                            {msg.content}
                          </>
                        )}
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
                );
              })}
              {chat.isLoading &&
                chat.messages[chat.messages.length - 1]?.content === "" &&
                !chat.messages[chat.messages.length - 1]?.parts?.length && (
                  <div className="flex items-center gap-2 px-4 py-2 text-muted-foreground">
                    {chat.retryInfo ? (
                      <>
                        <RefreshCw className="w-4 h-4 animate-spin" />
                        <span className="text-sm">
                          {LL.chat_retrying(
                            String(chat.retryInfo.attempt),
                            String(chat.retryInfo.maxRetries),
                          )}{" "}
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
          <PromptInput
            onSubmit={chat.handleSubmit}
            attachments={pendingAttachments}
            onAttachmentsChange={setPendingAttachments}
          >
            <PromptInputBody>
              <AttachmentChips
                attachments={pendingAttachments}
                onRemove={handleRemoveAttachment}
              />
              <div className="relative">
                <SkillMenu
                  input={chat.input}
                  onSelect={(cmd) => chat.setInput(cmd)}
                />
                <PromptInputTextarea
                  value={chat.input}
                  onChange={(e) => chat.setInput(e.target.value)}
                  onPaste={onPaste}
                  placeholder={LL.chat_inputPlaceholder()}
                />
              </div>
            </PromptInputBody>
            <PromptInputFooter>
              <div className="flex items-center gap-1">
                <PromptInputAttachButton
                  onClick={handlePickFiles}
                  disabled={chat.isLoading}
                />
                <button
                  type="button"
                  onClick={() => setMemoryOpen(true)}
                  aria-label="工作目录记忆"
                  title="工作目录记忆"
                  className="inline-flex items-center justify-center rounded-md p-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  <Brain className="size-4" />
                </button>
                <ModelSelector
                  selectedConfigId={chat.selectedLlmConfigId}
                  onSelect={chat.setSelectedLlmConfigId}
                />
              </div>
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
    </section>
  );
};
