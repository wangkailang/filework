import { useCallback, useEffect, useRef, useState } from "react";
import { useI18nContext } from "../../i18n/i18n-react";
import type { ApprovalState } from "../ai-elements/confirmation";
import { truncateTitle } from "./helpers";
import type { ChatMessage, MessagePart } from "./types";
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

  const crud = useSessionCrud(workspacePath);
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
  const handleSubmit = async (message: { text: string }) => {
    const text = message.text.trim();
    if (!text || stream.isLoading) return;

    setInput("");

    let sessionId = crud.activeSessionId;
    if (!sessionId) {
      sessionId = await crud.createNewSession();
    }

    const isFirstMessage = crud.messages.length === 0;

    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      sessionId,
      role: "user",
      content: text,
      timestamp: new Date().toISOString(),
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
      const title = truncateTitle(text);
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

    window.filework
      .checkNeedsPlanning({ prompt: userMessage.content })
      .then(({ needsPlanning: needs }: { needsPlanning: boolean }) => {
        if (needs) {
          plan.setIsPlanGenerating(true);
          return window.filework.generatePlan({
            prompt: userMessage.content,
            workspacePath,
            llmConfigId: selectedLlmConfigId || undefined,
          });
        }
        return window.filework.executeTask({
          prompt: userMessage.content,
          workspacePath,
          workspaceRefJson,
          sessionId,
          llmConfigId: selectedLlmConfigId || undefined,
          history,
        });
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
    setSelectedLlmConfigId: (id: string | null) => {
      setSelectedLlmConfigId(id);
      if (id) {
        localStorage.setItem("filework-selected-llm-config", id);
      } else {
        localStorage.removeItem("filework-selected-llm-config");
      }
    },
    retryInfo: stream.retryInfo,
    lastUsage: crud.lastUsage,
    lastError: crud.lastError,
    isStalled: plan.isStalled,
    handleSubmit,
    handleApproval,
    handleSkillApproval,
    handleApprovePlan: plan.handleApprovePlan,
    handleRejectPlan: plan.handleRejectPlan,
    handleCancelPlan: plan.handleCancelPlan,
    handleStopGeneration,
    handleNewChat: () => crud.handleNewChat(stream.isLoading),
    handleSelectSession: (id: string) =>
      crud.handleSelectSession(id, stream.isLoading),
    handleDeleteSession: crud.handleDeleteSession,
    handleForkSession: (fromMessageId: string) =>
      crud.handleForkSession(fromMessageId, stream.isLoading),
  };
}
