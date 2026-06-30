import { useCallback, useEffect, useRef, useState } from "react";
import {
  type ChatPermissionMode,
  DEFAULT_CHAT_PERMISSION_MODE,
  resolveChatPermissionMode,
} from "../../../shared/chat-permissions";
import { useI18nContext } from "../../i18n/i18n-react";
import type { ApprovalState } from "../ai-elements/confirmation";
import { truncateTitle } from "./helpers";
import { isSelectableLlmConfig } from "./ModelSelector";
import {
  clearSessionRunState,
  clearSessionUnreadState,
  getSessionRunState,
  markSessionPending,
  markSessionRunning,
  type SessionRunStateMap,
  settleSessionRunStateByTask,
} from "./session-run-state";
import type {
  AttachmentPart,
  ChatMessage,
  ChatSession,
  ClarificationPart,
  MessagePart,
  UsagePart,
} from "./types";
import { usePlanFlow } from "./usePlanFlow";
import { useSessionCrud } from "./useSessionCrud";
import { useStreamSubscription } from "./useStreamSubscription";

export interface RetryInfo {
  attempt: number;
  type: string;
  maxRetries: number;
}

export interface UsageInfo {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  modelId: string | null;
  provider: string | null;
}

const getLatestUsageInputTokens = (
  messages: Array<{ parts?: MessagePart[] | undefined }>,
): number => {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const parts = messages[i]?.parts ?? [];
    for (let j = parts.length - 1; j >= 0; j -= 1) {
      const part = parts[j];
      if (part.type !== "usage") continue;
      const inputTokens = (part as UsagePart).inputTokens;
      if (typeof inputTokens === "number" && Number.isFinite(inputTokens)) {
        return inputTokens;
      }
    }
  }
  return 0;
};

export interface StreamErrorInfo {
  message: string;
  type?: string;
  recoveryActions?: string[];
}

type AutomationRecordForChat = {
  id: string;
  modelId: string | null;
  prompt: string;
  scheduleKind: string;
  scheduleValue: string;
  title: string;
  type: string;
  workspacePaths: string[] | null;
};

type AutomationRunRecordForChat = {
  assistantMessageId: string | null;
  automationId: string;
  automationTitle: string;
  chatSessionId: string | null;
  errorMessage?: string | null;
  id: string;
  modelId: string | null;
  output?: string | null;
  prompt: string;
  trigger: "manual" | "scheduled";
  workspacePaths: string[] | null;
};

type AutomationChatPromptCopy = {
  instructions: string;
  runId: string;
  runNow: string;
  schedule: string;
  type: string;
  workspacePaths: string;
};

const scheduleAfterPaint = (callback: () => void) => {
  if (typeof window !== "undefined" && window.requestAnimationFrame) {
    window.requestAnimationFrame(() => callback());
    return;
  }
  setTimeout(callback, 0);
};

const CHAT_PERMISSION_STORAGE_KEY = "filework-chat-permission-mode";

const buildAutomationChatPrompt = (
  run: AutomationRunRecordForChat,
  automation?: AutomationRecordForChat,
  copy?: AutomationChatPromptCopy,
): string => {
  const lines = [
    copy?.runNow ?? `Run automation now: ${run.automationTitle}`,
    copy?.runId ?? `Automation run id: ${run.id}`,
  ];
  if (automation) {
    lines.push(
      copy?.type ?? `Automation type: ${automation.type}`,
      copy?.schedule ??
        `Schedule: ${automation.scheduleKind} ${automation.scheduleValue}`,
    );
  }
  if (run.workspacePaths?.length) {
    lines.push(
      copy?.workspacePaths ??
        `Workspace paths: ${run.workspacePaths.join(", ")}`,
    );
  }
  lines.push("", copy?.instructions ?? "Instructions:", run.prompt);
  return lines.join("\n");
};

const buildAutomationRunDetailContent = (
  run: AutomationRunRecordForChat,
): string =>
  run.output?.trim() ||
  run.errorMessage?.trim() ||
  "No output was captured for this automation run.";

export function useChatSession(
  workspacePath: string,
  workspaceRefJson?: string,
  activeBranch?: string | null,
) {
  const { LL } = useI18nContext();
  const [input, setInput] = useState("");
  const [selectedLlmConfigId, setSelectedLlmConfigId] = useState<string | null>(
    () => localStorage.getItem("filework-selected-llm-config") || null,
  );
  const [chatPermissionMode, setChatPermissionModeState] =
    useState<ChatPermissionMode>(() =>
      resolveChatPermissionMode(
        localStorage.getItem(CHAT_PERMISSION_STORAGE_KEY) ??
          DEFAULT_CHAT_PERMISSION_MODE,
      ),
    );
  const [sessionRunStates, setSessionRunStates] = useState<SessionRunStateMap>(
    {},
  );
  const [transientAutomationRun, setTransientAutomationRun] =
    useState<NonNullable<ChatSession["automationRun"]> | null>(null);

  // Validate persisted LLM config ID on mount
  const validatedConfigRef = useRef(false);
  const chatPermissionModeRef = useRef(chatPermissionMode);
  useEffect(() => {
    chatPermissionModeRef.current = chatPermissionMode;
  }, [chatPermissionMode]);
  useEffect(() => {
    if (validatedConfigRef.current || !selectedLlmConfigId) return;
    validatedConfigRef.current = true;
    window.filework.llmConfig
      .list()
      .then(
        (
          configs: {
            id: string;
            enabled?: boolean;
            lastCheckStatus?: "success" | "error" | null;
          }[],
        ) => {
          if (
            !configs.some(
              (c) => c.id === selectedLlmConfigId && isSelectableLlmConfig(c),
            )
          ) {
            setSelectedLlmConfigId(null);
            localStorage.removeItem("filework-selected-llm-config");
          }
        },
      )
      .catch(() => {});
  }, [selectedLlmConfigId]);

  // Subscribe once to media-job updates so any in-flight video job
  // (current session or restored from a prior run) updates its inline
  // VideoJobPart card. The hook is mounted for the chat surface's
  // lifetime; we tear down the listener on unmount.
  const crudRefForSubscribe = useRef<{
    setMessages: (updater: (prev: ChatMessage[]) => ChatMessage[]) => void;
    debouncedSave: (msgs: ChatMessage[], sid: string) => void;
    activeSessionIdRef: { current: string | null };
  } | null>(null);
  useEffect(() => {
    const off = window.filework.media.onJobUpdate(
      (evt: {
        jobId: string;
        status: "queued" | "running" | "succeeded" | "failed" | "canceled";
        progressPct?: number | null;
        resultPath?: string | null;
        errorMessage?: string | null;
      }) => {
        const refs = crudRefForSubscribe.current;
        if (!refs) return;
        refs.setMessages((prev) => {
          let mutated = false;
          const next = prev.map((m) => {
            if (!m.parts) return m;
            const newParts = m.parts.map((p) => {
              if (p.type !== "video-job" || p.jobId !== evt.jobId) return p;
              mutated = true;
              return {
                ...p,
                status: evt.status,
                progressPct: evt.progressPct ?? p.progressPct ?? null,
                resultPath: evt.resultPath ?? p.resultPath ?? null,
                errorMessage: evt.errorMessage ?? p.errorMessage ?? null,
              };
            });
            return mutated ? { ...m, parts: newParts } : m;
          });
          if (mutated && refs.activeSessionIdRef.current) {
            refs.debouncedSave(next, refs.activeSessionIdRef.current);
          }
          return mutated ? next : prev;
        });
      },
    );
    return () => {
      if (typeof off === "function") off();
    };
  }, []);

  const activeBranchSnapshot =
    typeof activeBranch === "string" && activeBranch.trim().length > 0
      ? activeBranch.trim()
      : null;
  const crud = useSessionCrud(workspacePath, activeBranchSnapshot);
  const handleTaskStarted = useCallback(
    (task: {
      sessionId?: string;
      taskId: string;
      assistantMessageId?: string;
    }) => {
      setSessionRunStates((prev) => markSessionRunning(prev, task));
    },
    [],
  );
  const handleTaskSettled = useCallback(
    (taskId: string) => {
      setSessionRunStates((prev) =>
        settleSessionRunStateByTask(
          prev,
          taskId,
          crud.activeSessionIdRef.current,
        ),
      );
    },
    [crud.activeSessionIdRef],
  );

  // Mirror the crud setters into a ref so the media-job subscriber
  // (mounted once, no deps) always sees the freshest setters without
  // re-subscribing on every render.
  crudRefForSubscribe.current = {
    setMessages: crud.setMessages,
    debouncedSave: crud.debouncedSave,
    activeSessionIdRef: crud.activeSessionIdRef,
  };
  const stream = useStreamSubscription({
    setMessages: crud.setMessages,
    updateSessionMessages: crud.updateSessionMessages,
    setLastUsage: crud.setLastUsage,
    setLastError: crud.setLastError,
    debouncedSave: crud.debouncedSave,
    activeSessionIdRef: crud.activeSessionIdRef,
    onTaskStarted: handleTaskStarted,
    onTaskSettled: handleTaskSettled,
  });

  useEffect(() => {
    let cancelled = false;
    const knownSessionIds = new Set(crud.sessions.map((s) => s.id));
    if (crud.activeSessionId) knownSessionIds.add(crud.activeSessionId);
    window.filework
      .getActiveTasks()
      .then((tasks) => {
        if (cancelled) return;
        const routedTasks = tasks.filter(
          (task) => task.sessionId && knownSessionIds.has(task.sessionId),
        );
        for (const task of routedTasks) {
          stream.rememberTaskRoute(task);
        }
        setSessionRunStates((prev) => {
          let next: SessionRunStateMap = {};
          for (const [sessionId, runState] of Object.entries(prev)) {
            if (
              (runState.status === "pending" || runState.status === "unread") &&
              knownSessionIds.has(sessionId)
            ) {
              next[sessionId] = runState;
            }
          }
          for (const task of routedTasks) next = markSessionRunning(next, task);
          return next;
        });
      })
      .catch(() => {
        if (!cancelled) {
          setSessionRunStates((prev) => {
            const next: SessionRunStateMap = {};
            for (const [sessionId, runState] of Object.entries(prev)) {
              if (
                (runState.status === "pending" ||
                  runState.status === "unread") &&
                knownSessionIds.has(sessionId)
              ) {
                next[sessionId] = runState;
              }
            }
            return next;
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [crud.sessions, crud.activeSessionId, stream.rememberTaskRoute]);

  const clearSessionRunStateBySession = useCallback((sessionId: string) => {
    setSessionRunStates((prev) => clearSessionRunState(prev, sessionId));
  }, []);

  const plan = usePlanFlow({
    setMessages: crud.setMessages,
    setIsLoading: stream.setIsLoading,
    debouncedSave: crud.debouncedSave,
    activeSessionIdRef: crud.activeSessionIdRef,
    streamTaskIdRef: stream.streamTaskIdRef,
    streamAssistantIdRef: stream.streamAssistantIdRef,
    pendingStopRef: stream.pendingStopRef,
  });

  // 刷新/重载后:会话历史加载完成时,尝试重连其仍在后台运行的任务(若有)。
  // 通过 useSessionCrud 的 onHistoryLoadedRef 接入,确保重连严格排在
  // setMessages(history) 之后 —— 避免重连补的在途消息壳被历史加载覆盖(进而丢事件)。
  crud.onHistoryLoadedRef.current = stream.reattachRunningTask;

  // ---------------------------------------------------------------------------
  // Submit & approval
  // ---------------------------------------------------------------------------
  const activeSessionRunState = getSessionRunState(
    sessionRunStates,
    crud.activeSessionId,
  );
  const isActiveSessionLoading =
    stream.isLoading ||
    activeSessionRunState?.status === "pending" ||
    activeSessionRunState?.status === "running";

  const handleSubmit = async (message: {
    text: string;
    attachments?: Array<Omit<AttachmentPart, "type">>;
  }) => {
    const text = message.text.trim();
    const attachments = message.attachments ?? [];
    if ((!text && attachments.length === 0) || isActiveSessionLoading) return;

    // Attachments are chat-modality only. Reject before persisting the
    // user message so the JSONL store doesn't carry an orphan record
    // referencing the wrong provider.
    if (attachments.length > 0 && selectedLlmConfigId) {
      const cfgRaw = await window.filework.llmConfig.get(selectedLlmConfigId);
      const modality =
        cfgRaw && !("error" in cfgRaw)
          ? (cfgRaw as { modality?: "chat" | "image" | "video" }).modality
          : null;
      if (modality === "image" || modality === "video") {
        crud.setLastError({
          message: `Attachments are only supported for chat models. Switch to a chat config to send "${attachments[0].name}".`,
        });
        return;
      }
    }

    setInput("");

    const shouldStartFreshFromTransient =
      !crud.activeSessionId && transientAutomationRun !== null;
    const baseMessages = shouldStartFreshFromTransient ? [] : crud.messages;
    if (shouldStartFreshFromTransient) setTransientAutomationRun(null);

    let sessionId = crud.activeSessionId;
    if (!sessionId) {
      sessionId = await crud.createNewSession();
    }

    const isFirstMessage = baseMessages.length === 0;

    const attachmentParts: AttachmentPart[] = attachments.map((a) => ({
      type: "attachment",
      path: a.path,
      name: a.name,
      mimeType: a.mimeType,
      size: a.size,
      kind: a.kind,
      attachmentId: a.attachmentId,
    }));

    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      sessionId,
      role: "user",
      content: text,
      timestamp: new Date().toISOString(),
      parts: attachmentParts.length > 0 ? attachmentParts : undefined,
    };

    const assistantId = crypto.randomUUID();
    const assistantMessage: ChatMessage = {
      id: assistantId,
      sessionId,
      role: "assistant",
      content: "",
      timestamp: new Date().toISOString(),
      parts: [],
    };

    const withBoth = [...baseMessages, userMessage, assistantMessage];
    crud.setMessages(withBoth);
    crud.debouncedSave(withBoth, sessionId, {
      lastActiveBranch: activeBranchSnapshot,
    });
    stream.setIsLoading(true);
    crud.setLastUsage(null);
    crud.setLastError(null);
    stream.setRetryInfo(null);
    stream.pendingStopRef.current = false;
    stream.stopRequestedRef.current = false;
    stream.streamAssistantIdRef.current = assistantId;
    setSessionRunStates((prev) =>
      markSessionPending(prev, { sessionId, assistantMessageId: assistantId }),
    );

    if (isFirstMessage) {
      const title = truncateTitle(text || attachmentParts[0]?.name || "Files");
      window.filework.updateChatSession(sessionId, { title });
      crud.setSessions((prev) =>
        prev.map((s) => (s.id === sessionId ? { ...s, title } : s)),
      );
    }

    if (stream.connectionTimeoutRef.current)
      clearTimeout(stream.connectionTimeoutRef.current);
    stream.connectionTimeoutRef.current = setTimeout(() => {
      if (
        stream.streamAssistantIdRef.current === assistantId &&
        !stream.streamTaskIdRef.current
      ) {
        const timeoutMsg = LL.chat_connectionTimeout();
        const errorPart: MessagePart = {
          type: "error",
          message: timeoutMsg,
          errorType: "timeout",
        };
        crud.setLastError({ message: timeoutMsg, type: "timeout" });
        crud.setMessages((prev) => {
          const idx = prev.findIndex((m) => m.id === assistantId);
          if (idx === -1) return prev;
          const updated = [...prev];
          updated[idx] = {
            ...updated[idx],
            content: timeoutMsg,
            parts: [errorPart],
          };
          if (crud.activeSessionIdRef.current) {
            crud.debouncedSave(updated, crud.activeSessionIdRef.current);
          }
          return updated;
        });
        stream.setIsLoading(false);
        stream.setRetryInfo(null);
        stream.streamTaskIdRef.current = null;
        stream.streamAssistantIdRef.current = null;
        clearSessionRunStateBySession(sessionId);
        stream.connectionTimeoutRef.current = null;
      }
    }, 30_000);

    // The agent decides whether to call createPlan — it has the full task
    // context that a regex-based IPC gate could not see.
    scheduleAfterPaint(() => {
      const history: Array<{
        role: ChatMessage["role"];
        content: string;
        parts: MessagePart[] | undefined;
      }> = [];
      for (const { id, role, content, parts } of withBoth) {
        if (id === assistantId) continue;
        history.push({
          role,
          content,
          parts: parts?.filter((p) => p.type !== "plan"),
        });
      }
      const contextInputTokens = getLatestUsageInputTokens(history);

      window.filework
        .executeTask({
          prompt: userMessage.content,
          workspacePath,
          workspaceRefJson,
          sessionId,
          assistantMessageId: assistantId,
          chatPermissionMode: chatPermissionModeRef.current,
          contextInputTokens,
          llmConfigId: selectedLlmConfigId || undefined,
          history,
        })
        .catch((error: unknown) => {
          if (stream.streamAssistantIdRef.current !== assistantId) return;
          const errMsg =
            error instanceof Error ? error.message : LL.chat_unknownError();
          const errorPart: MessagePart = {
            type: "error",
            message: errMsg,
          };
          crud.setLastError({ message: errMsg });
          crud.setMessages((prev) => {
            const idx = prev.findIndex((m) => m.id === assistantId);
            if (idx === -1) return prev;
            const updated = [...prev];
            updated[idx] = {
              ...updated[idx],
              content: errMsg,
              parts: [errorPart],
            };
            if (crud.activeSessionIdRef.current) {
              crud.debouncedSave(updated, crud.activeSessionIdRef.current);
            }
            return updated;
          });
          stream.setIsLoading(false);
          stream.setRetryInfo(null);
          stream.streamTaskIdRef.current = null;
          stream.streamAssistantIdRef.current = null;
          clearSessionRunStateBySession(sessionId);
        });
    });
  };

  const handleTriggerAutomationRun = useCallback(
    async (automation: AutomationRecordForChat) => {
      const sessionId = await crud.createNewSession();
      const assistantId = crypto.randomUUID();
      const prepared = await window.filework.automations.prepareChatRun({
        assistantMessageId: assistantId,
        id: automation.id,
        sessionId,
      });
      const prompt = buildAutomationChatPrompt(prepared, automation, {
        instructions: LL.automations_chatPromptInstructions(),
        runId: LL.automations_chatPromptRunId({ id: prepared.id }),
        runNow: LL.automations_chatPromptRunNow({
          title: prepared.automationTitle,
        }),
        schedule: LL.automations_chatPromptSchedule({
          kind: automation.scheduleKind,
          value: automation.scheduleValue,
        }),
        type: LL.automations_chatPromptType({ value: automation.type }),
        workspacePaths: LL.automations_chatPromptWorkspacePaths({
          value: prepared.workspacePaths?.join(", ") ?? "",
        }),
      });
      const now = new Date().toISOString();
      const userMessage: ChatMessage = {
        id: crypto.randomUUID(),
        sessionId,
        role: "user",
        content: prompt,
        timestamp: now,
      };
      const assistantMessage: ChatMessage = {
        id: assistantId,
        sessionId,
        role: "assistant",
        content: "",
        timestamp: now,
        parts: [],
      };
      const messages = [userMessage, assistantMessage];
      const title = prepared.automationTitle;

      window.filework.updateChatSession(sessionId, { title });
      crud.setSessions((prev) =>
        prev.map((s) =>
          s.id === sessionId
            ? {
                ...s,
                automationRun: {
                  automationId: prepared.automationId,
                  id: prepared.id,
                  title,
                },
                title,
              }
            : s,
        ),
      );
      crud.setMessages(messages);
      crud.debouncedSave(messages, sessionId);
      stream.setIsLoading(true);
      crud.setLastUsage(null);
      crud.setLastError(null);
      stream.setRetryInfo(null);
      stream.pendingStopRef.current = false;
      stream.stopRequestedRef.current = false;
      stream.streamAssistantIdRef.current = assistantId;
      setSessionRunStates((prev) =>
        markSessionPending(prev, {
          sessionId,
          assistantMessageId: assistantId,
        }),
      );

      const executionWorkspacePath =
        prepared.workspacePaths?.[0] ?? workspacePath;
      const executionWorkspaceRefJson =
        executionWorkspacePath === workspacePath ? workspaceRefJson : undefined;
      const history = messages
        .filter((m) => m.id !== assistantId)
        .map(({ role, content, parts }) => ({
          role,
          content,
          parts: parts?.filter((p) => p.type !== "plan"),
        }));
      const contextInputTokens = getLatestUsageInputTokens(history);

      window.filework
        .executeTask({
          prompt,
          workspacePath: executionWorkspacePath,
          workspaceRefJson: executionWorkspaceRefJson,
          sessionId,
          assistantMessageId: assistantId,
          automationRunId: prepared.id,
          chatPermissionMode: chatPermissionModeRef.current,
          contextInputTokens,
          llmConfigId:
            prepared.modelId ??
            automation.modelId ??
            selectedLlmConfigId ??
            undefined,
          history,
        })
        .catch((error: unknown) => {
          if (stream.streamAssistantIdRef.current !== assistantId) return;
          const errMsg =
            error instanceof Error ? error.message : LL.chat_unknownError();
          const errorPart: MessagePart = {
            type: "error",
            message: errMsg,
          };
          crud.setLastError({ message: errMsg });
          crud.setMessages((prev) => {
            const idx = prev.findIndex((m) => m.id === assistantId);
            if (idx === -1) return prev;
            const updated = [...prev];
            updated[idx] = {
              ...updated[idx],
              content: errMsg,
              parts: [errorPart],
            };
            crud.debouncedSave(updated, sessionId);
            return updated;
          });
          stream.setIsLoading(false);
          stream.setRetryInfo(null);
          stream.streamTaskIdRef.current = null;
          stream.streamAssistantIdRef.current = null;
          clearSessionRunStateBySession(sessionId);
        });
    },
    [
      LL,
      crud,
      selectedLlmConfigId,
      stream,
      workspacePath,
      workspaceRefJson,
      clearSessionRunStateBySession,
    ],
  );

  const handleOpenAutomationRun = useCallback(
    async (run: AutomationRunRecordForChat) => {
      const existingSessionId =
        run.chatSessionId ??
        crud.sessions.find((session) => session.automationRun?.id === run.id)
          ?.id ??
        null;
      if (existingSessionId) {
        stream.detachFromTask();
        setTransientAutomationRun(null);
        setSessionRunStates((prev) =>
          clearSessionUnreadState(prev, existingSessionId),
        );
        crud.handleSelectSession(existingSessionId, false);
        return true;
      }

      const assistantId = run.assistantMessageId ?? crypto.randomUUID();
      const transientSessionId = `automation-run:${run.id}`;
      const title = run.automationTitle;
      const now = new Date().toISOString();
      const userMessage: ChatMessage = {
        id: crypto.randomUUID(),
        sessionId: transientSessionId,
        role: "user",
        content: buildAutomationChatPrompt(run),
        timestamp: now,
      };
      const assistantContent = buildAutomationRunDetailContent(run);
      const assistantMessage: ChatMessage = {
        id: assistantId,
        sessionId: transientSessionId,
        role: "assistant",
        content: assistantContent,
        timestamp: now,
        parts: [{ type: "text", text: assistantContent }],
      };
      const messages = [userMessage, assistantMessage];

      stream.detachFromTask();
      setTransientAutomationRun({
        automationId: run.automationId,
        id: run.id,
        title,
      });
      crud.showTransientMessages(messages);
      return true;
    },
    [crud, stream.detachFromTask],
  );

  const handleApproval = (toolCallId: string, approved: boolean) => {
    crud.setMessages((prev) => {
      const assistantId = stream.streamAssistantIdRef.current;
      const idx = prev.findIndex((m) => m.id === assistantId);
      if (idx === -1) return prev;
      const updated = [...prev];
      const msg = updated[idx];
      const newParts = (msg.parts ?? []).map((p) => {
        if (p.type !== "tool" || p.toolCallId !== toolCallId || !p.approval)
          return p;
        return {
          ...p,
          approval: {
            ...p.approval,
            state: (approved
              ? "approval-accepted"
              : "approval-rejected") as ApprovalState,
          },
        };
      });
      updated[idx] = { ...msg, parts: newParts };
      return updated;
    });
    window.filework.approveToolCall(toolCallId, approved);
  };

  const handleBatchApproval = (
    batchId: string,
    approved: boolean,
    remember = false,
  ) => {
    crud.setMessages((prev) => {
      const assistantId = stream.streamAssistantIdRef.current;
      const idx = prev.findIndex((m) => m.id === assistantId);
      if (idx === -1) return prev;
      const updated = [...prev];
      const msg = updated[idx];
      const newParts = (msg.parts ?? []).map((p) => {
        if (p.type !== "batch-approval" || p.batchId !== batchId) return p;
        return {
          ...p,
          state: (approved
            ? "approval-accepted"
            : "approval-rejected") as ApprovalState,
        };
      });
      updated[idx] = { ...msg, parts: newParts };
      return updated;
    });
    window.filework.approveToolCallBatch(batchId, approved, remember);
  };

  /**
   * Route a clarification button click back to the suspended
   * `askClarification` tool via IPC, then persist the chosen option on
   * the message part so the UI re-renders in the answered state.
   *
   * Falls back to `handleSubmit({ text: opt })` when the IPC reports
   * `ok:false` — that happens for legacy parts without a
   * `clarificationId`, and for any clarification persisted across a
   * restart (the main-process pendingClarifications map is empty after
   * reload). In those cases the user's pick at least lands as a fresh
   * chat turn instead of silently no-op'ing.
   */
  const handleClarificationPick = async (
    clarificationId: string | undefined,
    opt: string,
  ): Promise<void> => {
    let answered = false;
    if (clarificationId) {
      try {
        const res = await window.filework.answerClarification({
          clarificationId,
          answer: opt,
        });
        answered = !!res?.ok;
      } catch {
        answered = false;
      }
    }
    if (answered) {
      crud.setMessages((prev) => {
        let touched = false;
        const next = prev.map((m) => {
          if (!m.parts) return m;
          let mTouched = false;
          const newParts = m.parts.map((p): MessagePart => {
            if (
              p.type === "clarification" &&
              (p as ClarificationPart).clarificationId === clarificationId
            ) {
              mTouched = true;
              touched = true;
              return { ...p, answeredOption: opt } as ClarificationPart;
            }
            return p;
          });
          return mTouched ? { ...m, parts: newParts } : m;
        });
        if (touched && crud.activeSessionIdRef.current) {
          crud.debouncedSave(next, crud.activeSessionIdRef.current);
        }
        return next;
      });
      return;
    }
    // Stale or no clarificationId — fall back to a fresh chat turn so
    // the user's pick is at least visible and routable as a prompt.
    handleSubmit({ text: opt });
  };

  const activeSessionTaskId =
    activeSessionRunState?.status === "running"
      ? activeSessionRunState.taskId
      : null;

  const handleStopGeneration = useCallback(() => {
    const taskId = stream.streamTaskIdRef.current ?? activeSessionTaskId;
    console.log(
      "[Stop Generation] Current taskId:",
      taskId,
      "isLoading:",
      stream.isLoading,
    );
    stream.stopRequestedRef.current = true;

    if (!taskId) {
      if (stream.isLoading) {
        stream.pendingStopRef.current = true;
      }
      console.warn(
        "[Stop Generation] No active taskId found, cannot stop generation because no task id is associated with the current stream",
      );
      return;
    }

    console.log("[Stop Generation] Attempting to stop taskId:", taskId);
    window.filework
      .stopGeneration(taskId)
      .then(() => {
        console.log(
          "[Stop Generation] Stop request sent successfully for taskId:",
          taskId,
        );
      })
      .catch((error) => {
        console.error("[Stop Generation] Failed to stop generation:", error);
        stream.setIsLoading(false);
        stream.setActiveSkill(null);
        stream.streamTaskIdRef.current = null;
        stream.streamAssistantIdRef.current = null;
      });
  }, [
    stream.isLoading,
    activeSessionTaskId,
    stream.pendingStopRef,
    stream.stopRequestedRef,
    stream.streamAssistantIdRef,
    stream.streamTaskIdRef,
    stream.setActiveSkill,
    stream.setIsLoading,
  ]);

  const handleSkillApproval = (approved: boolean) => {
    if (!stream.pendingSkillApproval) return;
    window.filework.approveSkill({
      skillId: stream.pendingSkillApproval.skillId,
      approved,
    });
    stream.setPendingSkillApproval(null);
  };

  // 稳定下列 handler 的引用,使 ChatSessionProvider 的低频切片在流式期间
  // 能 bail-out(顶栏 / 左栏会话列表不随 messages 逐 token 重渲)。
  const handleNewChat = useCallback(() => {
    stream.detachFromTask();
    setTransientAutomationRun(null);
    crud.handleNewChat(false);
  }, [crud.handleNewChat, stream.detachFromTask]);
  const handleSelectSession = useCallback(
    (id: string) => {
      stream.detachFromTask();
      setTransientAutomationRun(null);
      setSessionRunStates((prev) => clearSessionUnreadState(prev, id));
      crud.handleSelectSession(id, false);
    },
    [crud.handleSelectSession, stream.detachFromTask],
  );
  const handleDeleteSession = useCallback(
    async (id: string) => {
      const runState = getSessionRunState(sessionRunStates, id);
      if (runState?.status === "running") {
        await window.filework.stopGeneration(runState.taskId);
      }
      setSessionRunStates((prev) => clearSessionRunState(prev, id));
      if (id === crud.activeSessionId) stream.detachFromTask();
      await crud.handleDeleteSession(id);
    },
    [
      crud.activeSessionId,
      crud.handleDeleteSession,
      sessionRunStates,
      stream.detachFromTask,
    ],
  );
  const handleForkSession = useCallback(
    (fromMessageId: string) =>
      crud.handleForkSession(fromMessageId, isActiveSessionLoading),
    [crud.handleForkSession, isActiveSessionLoading],
  );
  const setSelectedLlmConfigIdStable = useCallback((id: string | null) => {
    setSelectedLlmConfigId(id);
    if (id) {
      localStorage.setItem("filework-selected-llm-config", id);
    } else {
      localStorage.removeItem("filework-selected-llm-config");
    }
  }, []);
  const setChatPermissionMode = useCallback((mode: ChatPermissionMode) => {
    const next = resolveChatPermissionMode(mode);
    chatPermissionModeRef.current = next;
    setChatPermissionModeState(next);
    localStorage.setItem(CHAT_PERMISSION_STORAGE_KEY, next);
  }, []);

  return {
    sessions: crud.sessions,
    activeSessionId: crud.activeSessionId,
    transientAutomationRun,
    sessionRunStates,
    activeSessionRunState,
    messages: crud.messages,
    input,
    setInput,
    isLoading: isActiveSessionLoading,
    isPlanGenerating: plan.isPlanGenerating,
    activePlanId: plan.activePlanId,
    activeSkill: stream.activeSkill,
    pendingSkillApproval: stream.pendingSkillApproval,
    chatPermissionMode,
    setChatPermissionMode,
    selectedLlmConfigId,
    setSelectedLlmConfigId: setSelectedLlmConfigIdStable,
    retryInfo: stream.retryInfo,
    lastUsage: crud.lastUsage,
    lastError: crud.lastError,
    setLastError: crud.setLastError,
    isStalled: plan.isStalled,
    handleSubmit,
    handleApproval,
    handleBatchApproval,
    handleClarificationPick,
    handleSkillApproval,
    handleApprovePlan: plan.handleApprovePlan,
    handleRejectPlan: plan.handleRejectPlan,
    handleCancelPlan: plan.handleCancelPlan,
    handleStopGeneration,
    handleNewChat,
    handleTriggerAutomationRun,
    handleOpenAutomationRun,
    handleSelectSession,
    handleDeleteSession,
    handleRenameSession: crud.handleRenameSession,
    handleForkSession,
  };
}
