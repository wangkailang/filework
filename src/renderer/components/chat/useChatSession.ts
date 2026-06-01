import { useCallback, useEffect, useRef, useState } from "react";
import { useI18nContext } from "../../i18n/i18n-react";
import type { ApprovalState } from "../ai-elements/confirmation";
import { truncateTitle } from "./helpers";
import type {
  AttachmentPart,
  ChatMessage,
  ClarificationPart,
  MessagePart,
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

export interface StreamErrorInfo {
  message: string;
  type?: string;
  recoveryActions?: string[];
}

export function useChatSession(
  workspacePath: string,
  workspaceRefJson?: string,
) {
  const { LL } = useI18nContext();
  const [input, setInput] = useState("");
  const [selectedLlmConfigId, setSelectedLlmConfigId] = useState<string | null>(
    () => localStorage.getItem("filework-selected-llm-config") || null,
  );

  // Validate persisted LLM config ID on mount
  const validatedConfigRef = useRef(false);
  useEffect(() => {
    if (validatedConfigRef.current || !selectedLlmConfigId) return;
    validatedConfigRef.current = true;
    window.filework.llmConfig
      .list()
      .then((configs: { id: string }[]) => {
        if (!configs.some((c) => c.id === selectedLlmConfigId)) {
          setSelectedLlmConfigId(null);
          localStorage.removeItem("filework-selected-llm-config");
        }
      })
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

  const crud = useSessionCrud(workspacePath);
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
    setLastUsage: crud.setLastUsage,
    setLastError: crud.setLastError,
    debouncedSave: crud.debouncedSave,
    activeSessionIdRef: crud.activeSessionIdRef,
  });
  const plan = usePlanFlow({
    setMessages: crud.setMessages,
    setIsLoading: stream.setIsLoading,
    debouncedSave: crud.debouncedSave,
    activeSessionIdRef: crud.activeSessionIdRef,
    streamTaskIdRef: stream.streamTaskIdRef,
    streamAssistantIdRef: stream.streamAssistantIdRef,
    pendingStopRef: stream.pendingStopRef,
  });

  // ---------------------------------------------------------------------------
  // Submit & approval
  // ---------------------------------------------------------------------------
  const handleSubmit = async (message: {
    text: string;
    attachments?: Array<Omit<AttachmentPart, "type">>;
  }) => {
    const text = message.text.trim();
    const attachments = message.attachments ?? [];
    if ((!text && attachments.length === 0) || stream.isLoading) return;

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

    let sessionId = crud.activeSessionId;
    if (!sessionId) {
      sessionId = await crud.createNewSession();
    }

    const isFirstMessage = crud.messages.length === 0;

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

    const withBoth = [...crud.messages, userMessage, assistantMessage];
    crud.setMessages(withBoth);
    crud.debouncedSave(withBoth, sessionId);
    stream.setIsLoading(true);
    crud.setLastUsage(null);
    crud.setLastError(null);
    stream.setRetryInfo(null);
    stream.pendingStopRef.current = false;
    stream.stopRequestedRef.current = false;
    stream.streamAssistantIdRef.current = assistantId;

    if (isFirstMessage) {
      const title = truncateTitle(text || attachmentParts[0]?.name || "Files");
      window.filework.updateChatSession(sessionId, { title });
      crud.setSessions((prev) =>
        prev.map((s) => (s.id === sessionId ? { ...s, title } : s)),
      );
    }

    const history = withBoth
      .filter((m) => m.id !== assistantId)
      .map(({ role, content, parts }) => ({
        role,
        content,
        parts: parts?.filter((p) => p.type !== "plan"),
      }));

    // Image/video modalities bypass the agent loop — both return a
    // single part (image, video-job, or error) and exit. Centralise the
    // "set parts → debouncedSave" dance so adding a new modality stays
    // a one-liner.
    const replaceAssistant = (parts: MessagePart[], content = "") => {
      crud.setMessages((prev) => {
        const idx = prev.findIndex((m) => m.id === assistantId);
        if (idx === -1) return prev;
        const updated = [...prev];
        updated[idx] = { ...updated[idx], content, parts };
        if (crud.activeSessionIdRef.current) {
          crud.debouncedSave(updated, crud.activeSessionIdRef.current);
        }
        return updated;
      });
    };
    const replaceWithError = (msg: string) => {
      crud.setLastError({ message: msg });
      replaceAssistant([{ type: "error", message: msg }], msg);
    };

    if (selectedLlmConfigId) {
      try {
        const configRaw =
          await window.filework.llmConfig.get(selectedLlmConfigId);
        const config =
          configRaw && !("error" in configRaw)
            ? (configRaw as {
                id: string;
                modality?: "chat" | "image" | "video";
                model: string;
              })
            : null;
        if (config?.modality === "image") {
          const result = (await window.filework.media.generateImage({
            llmConfigId: selectedLlmConfigId,
            sessionId,
            prompt: text,
          })) as
            | {
                path: string;
                prompt: string;
                configId: string;
                imageId: string;
              }
            | { error: string };
          if ("error" in result) {
            replaceWithError(result.error);
          } else {
            replaceAssistant([
              {
                type: "image",
                path: result.path,
                prompt: result.prompt,
                configId: result.configId,
                imageId: result.imageId,
                modelId: config.model,
              },
            ]);
          }
        } else if (config?.modality === "video") {
          const result = (await window.filework.media.createVideoJob({
            llmConfigId: selectedLlmConfigId,
            sessionId,
            prompt: text,
          })) as
            | {
                jobId: string;
                status: "queued";
                configId: string;
                prompt: string;
                modelId: string;
              }
            | { error: string };
          if ("error" in result) {
            replaceWithError(result.error);
          } else {
            replaceAssistant([
              {
                type: "video-job",
                jobId: result.jobId,
                status: "queued",
                prompt: result.prompt,
                configId: result.configId,
                modelId: result.modelId,
              },
            ]);
          }
        }
        if (config?.modality === "image" || config?.modality === "video") {
          stream.setIsLoading(false);
          stream.streamAssistantIdRef.current = null;
          return;
        }
      } catch (err) {
        replaceWithError(err instanceof Error ? err.message : String(err));
        stream.setIsLoading(false);
        stream.streamAssistantIdRef.current = null;
        return;
      }
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
        stream.connectionTimeoutRef.current = null;
      }
    }, 30_000);

    // The agent decides whether to call createPlan — it has the full task
    // context that a regex-based IPC gate could not see.
    window.filework
      .executeTask({
        prompt: userMessage.content,
        workspacePath,
        workspaceRefJson,
        sessionId,
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
      });
  };

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

  const handleStopGeneration = useCallback(() => {
    const taskId = stream.streamTaskIdRef.current;
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
  const handleNewChat = useCallback(
    () => crud.handleNewChat(stream.isLoading),
    [crud.handleNewChat, stream.isLoading],
  );
  const handleSelectSession = useCallback(
    (id: string) => crud.handleSelectSession(id, stream.isLoading),
    [crud.handleSelectSession, stream.isLoading],
  );
  const handleForkSession = useCallback(
    (fromMessageId: string) =>
      crud.handleForkSession(fromMessageId, stream.isLoading),
    [crud.handleForkSession, stream.isLoading],
  );
  const setSelectedLlmConfigIdStable = useCallback((id: string | null) => {
    setSelectedLlmConfigId(id);
    if (id) {
      localStorage.setItem("filework-selected-llm-config", id);
    } else {
      localStorage.removeItem("filework-selected-llm-config");
    }
  }, []);

  return {
    sessions: crud.sessions,
    activeSessionId: crud.activeSessionId,
    messages: crud.messages,
    input,
    setInput,
    isLoading: stream.isLoading,
    isPlanGenerating: plan.isPlanGenerating,
    activePlanId: plan.activePlanId,
    activeSkill: stream.activeSkill,
    pendingSkillApproval: stream.pendingSkillApproval,
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
    handleSelectSession,
    handleDeleteSession: crud.handleDeleteSession,
    handleRenameSession: crud.handleRenameSession,
    handleForkSession,
  };
}
