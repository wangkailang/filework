import { type MutableRefObject, useEffect, useRef, useState } from "react";
import { useI18nContext } from "../../i18n/i18n-react";
import type { ApprovalState } from "../ai-elements/confirmation";
import { contentFromParts } from "./helpers";
import type { SkillApprovalData } from "./SkillApprovalDialog";
import type {
  ActiveSkillInfo,
  ChatMessage,
  ErrorPart,
  MessagePart,
  ToolApproval,
  ToolPart,
  UsagePart,
} from "./types";
import type { RetryInfo, StreamErrorInfo, UsageInfo } from "./useChatSession";

interface StreamSubscriptionDeps {
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  setLastUsage: React.Dispatch<React.SetStateAction<UsageInfo | null>>;
  setLastError: React.Dispatch<React.SetStateAction<StreamErrorInfo | null>>;
  debouncedSave: (msgs: ChatMessage[], sessionId: string) => void;
  activeSessionIdRef: MutableRefObject<string | null>;
}

export function useStreamSubscription({
  setMessages,
  setLastUsage,
  setLastError,
  debouncedSave,
  activeSessionIdRef,
}: StreamSubscriptionDeps) {
  const { LL } = useI18nContext();
  const [isLoading, setIsLoading] = useState(false);
  const [activeSkill, setActiveSkill] = useState<ActiveSkillInfo | null>(null);
  const [pendingSkillApproval, setPendingSkillApproval] =
    useState<SkillApprovalData | null>(null);
  const [retryInfo, setRetryInfo] = useState<RetryInfo | null>(null);
  const [isStalled, setIsStalled] = useState(false);

  const streamTaskIdRef = useRef<string | null>(null);
  const streamAssistantIdRef = useRef<string | null>(null);
  const pendingStopRef = useRef(false);
  const stopRequestedRef = useRef(false);
  const connectionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  useEffect(() => {
    const offStart = window.filework.onStreamStart(({ id }) => {
      console.log("[Stream Start] Setting taskId:", id);
      streamTaskIdRef.current = id;
      setIsStalled(false);
      if (connectionTimeoutRef.current) {
        clearTimeout(connectionTimeoutRef.current);
        connectionTimeoutRef.current = null;
      }
      if (pendingStopRef.current) {
        pendingStopRef.current = false;
        window.filework.stopGeneration(id).catch((error) => {
          console.error(
            "[Stop Generation] Failed to stop deferred task:",
            error,
          );
        });
      }
    });

    const offSkillActivated = window.filework.onSkillActivated(
      ({ id, skillId, skillName, source }) => {
        if (id !== streamTaskIdRef.current) return;
        setActiveSkill({ skillId, skillName, source });
      },
    );

    const updateParts = (updater: (parts: MessagePart[]) => MessagePart[]) => {
      setMessages((prev) => {
        const idx = prev.findIndex(
          (m) => m.id === streamAssistantIdRef.current,
        );
        if (idx === -1) return prev;
        const updated = [...prev];
        const msg = updated[idx];
        const newParts = updater([...(msg.parts ?? [])]);
        updated[idx] = {
          ...msg,
          parts: newParts,
          content: contentFromParts(newParts),
        };
        return updated;
      });
    };

    const offDelta = window.filework.onStreamDelta(({ id, delta }) => {
      if (id !== streamTaskIdRef.current) return;
      updateParts((parts) => {
        const last = parts[parts.length - 1];
        if (last && last.type === "text") {
          parts[parts.length - 1] = { ...last, text: last.text + delta };
        } else {
          parts.push({ type: "text", text: delta });
        }
        return parts;
      });
    });

    const offToolCall = window.filework.onStreamToolCall(
      ({ id, toolCallId, toolName, args }) => {
        if (id !== streamTaskIdRef.current) return;
        updateParts((parts) => {
          const existingIdx = parts.findIndex(
            (p) => p.type === "tool" && p.toolCallId === toolCallId,
          );
          if (existingIdx !== -1) {
            parts[existingIdx] = { ...(parts[existingIdx] as ToolPart), args };
          } else {
            parts.push({
              type: "tool",
              toolCallId,
              toolName,
              args,
              state: "input-available",
            });
          }
          return parts;
        });
      },
    );

    const offToolResult = window.filework.onStreamToolResult(
      ({ id, toolCallId, result }) => {
        if (id !== streamTaskIdRef.current) return;
        updateParts((parts) => {
          const isDenied =
            result != null &&
            typeof result === "object" &&
            "denied" in result &&
            (result as Record<string, unknown>).denied === true;
          return parts.map((p) => {
            if (p.type !== "tool" || p.toolCallId !== toolCallId) return p;
            return {
              ...p,
              result,
              state: "output-available" as const,
              approval: p.approval
                ? {
                    ...p.approval,
                    state: (isDenied
                      ? "approval-rejected"
                      : "approval-accepted") as ApprovalState,
                  }
                : undefined,
            };
          });
        });
      },
    );

    const offToolApproval = window.filework.onStreamToolApproval(
      ({ id, toolCallId, toolName, args, description, extraContext }) => {
        if (id !== streamTaskIdRef.current) return;
        updateParts((parts) => {
          const existingIdx = parts.findIndex(
            (p) => p.type === "tool" && p.toolCallId === toolCallId,
          );
          const approval: ToolApproval = {
            toolCallId,
            toolName,
            description,
            state: "approval-requested",
            extraContext,
          };
          if (existingIdx !== -1) {
            parts[existingIdx] = {
              ...(parts[existingIdx] as ToolPart),
              approval,
            };
          } else {
            parts.push({
              type: "tool",
              toolCallId,
              toolName,
              args,
              state: "input-available",
              approval,
            });
          }
          return parts;
        });
      },
    );

    const offDone = window.filework.onStreamDone(({ id }) => {
      if (id !== streamTaskIdRef.current) return;
      console.log("[Stream Done] Cleaning up taskId:", id);
      if (connectionTimeoutRef.current) {
        clearTimeout(connectionTimeoutRef.current);
        connectionTimeoutRef.current = null;
      }
      const assistantId = streamAssistantIdRef.current;
      const stoppedByUser = stopRequestedRef.current;
      streamTaskIdRef.current = null;
      pendingStopRef.current = false;
      stopRequestedRef.current = false;
      setIsLoading(false);
      setActiveSkill(null);
      setRetryInfo(null);
      setLastError(null);
      setIsStalled(false);

      if (stoppedByUser && assistantId) {
        setMessages((prev) => {
          const idx = prev.findIndex((m) => m.id === assistantId);
          if (idx === -1) return prev;
          const updated = [...prev];
          const msg = updated[idx];
          const normalizedParts = (msg.parts ?? []).map((part) => {
            if (part.type !== "tool") return part;
            if (
              part.state === "output-available" ||
              part.state === "output-error"
            )
              return part;
            return {
              ...part,
              state: "output-available" as const,
              result: part.result ?? {
                success: false,
                cancelled: true,
                reason: LL.chat_userStopped(),
              },
            };
          });
          updated[idx] = {
            ...msg,
            parts: normalizedParts,
            content: contentFromParts(normalizedParts),
          };
          return updated;
        });
      }

      window.filework.usage
        .getTaskUsage(id)
        .then((usage: UsageInfo | null) => {
          if (usage && usage.totalTokens != null) {
            setLastUsage(usage);
            setMessages((prev) => {
              const idx = prev.findIndex((m) => m.id === assistantId);
              if (idx === -1) return prev;
              const updated = [...prev];
              const msg = updated[idx];
              const usagePart: UsagePart = { type: "usage", ...usage };
              const newParts: MessagePart[] = [...(msg.parts ?? []), usagePart];
              updated[idx] = { ...msg, parts: newParts };
              if (activeSessionIdRef.current) {
                debouncedSave(updated, activeSessionIdRef.current);
              }
              return updated;
            });
          } else {
            setMessages((prev) => {
              streamAssistantIdRef.current = null;
              if (activeSessionIdRef.current) {
                debouncedSave(prev, activeSessionIdRef.current);
              }
              return prev;
            });
          }
          streamAssistantIdRef.current = null;
        })
        .catch(() => {
          streamAssistantIdRef.current = null;
          setMessages((prev) => {
            if (activeSessionIdRef.current) {
              debouncedSave(prev, activeSessionIdRef.current);
            }
            return prev;
          });
        });
    });

    const offError = window.filework.onStreamError(
      ({ id, error, type, recoveryActions }) => {
        if (streamTaskIdRef.current && id !== streamTaskIdRef.current) return;
        if (!streamTaskIdRef.current && !streamAssistantIdRef.current) return;
        console.log("[Stream Error] Cleaning up taskId:", id, "error:", error);
        if (connectionTimeoutRef.current) {
          clearTimeout(connectionTimeoutRef.current);
          connectionTimeoutRef.current = null;
        }
        const assistantId = streamAssistantIdRef.current;
        streamTaskIdRef.current = null;
        pendingStopRef.current = false;
        stopRequestedRef.current = false;
        setIsLoading(false);
        setActiveSkill(null);
        setRetryInfo(null);
        setLastError({ message: error, type, recoveryActions });
        setMessages((prev) => {
          const idx = prev.findIndex((m) => m.id === assistantId);
          if (idx === -1) return prev;
          const updated = [...prev];
          const msg = updated[idx];
          const errorPart: MessagePart = {
            type: "error",
            message: error,
            errorType: type,
            recoveryActions: recoveryActions as ErrorPart["recoveryActions"],
          };
          const existingParts =
            msg.parts && msg.parts.length > 0 ? msg.parts : [];
          const newParts: MessagePart[] = [...existingParts, errorPart];
          updated[idx] = {
            ...msg,
            content: msg.content || error,
            parts: newParts,
          };
          if (activeSessionIdRef.current) {
            debouncedSave(updated, activeSessionIdRef.current);
          }
          return updated;
        });
        streamAssistantIdRef.current = null;
      },
    );

    const offClarification = window.filework.onStreamClarification(
      ({ id, question, options }) => {
        if (id !== streamTaskIdRef.current) return;
        updateParts((parts) => {
          parts.push({
            type: "clarification",
            question,
            options: options?.filter(Boolean),
          });
          return parts;
        });
      },
    );

    const offRetry = window.filework.onStreamRetry(
      ({ id, attempt, type, maxRetries }) => {
        if (id !== streamTaskIdRef.current) return;
        setRetryInfo({ attempt, type, maxRetries });
      },
    );

    const offSkillApprovalRequest = window.filework.onSkillApprovalRequest(
      (data) => {
        setPendingSkillApproval(data);
      },
    );

    // M12: CI watcher events — surface inline in the chat as text parts.
    // Match by streamTaskIdRef so events for a stale task drop silently.
    const offCiRunDone = window.filework.onCiRunDone(
      ({ id, runId, conclusion, url, name }) => {
        if (id !== streamTaskIdRef.current) return;
        const verdict = conclusion ?? "未知";
        updateParts((parts) => {
          parts.push({
            type: "text",
            text: `🔔 CI 运行 ${name} (#${runId}) 已完成,结果: ${verdict} — ${url}`,
          });
          return parts;
        });
      },
    );

    const offCiRunTimeout = window.filework.onCiRunTimeout(
      ({ id, runId, elapsedMs }) => {
        if (id !== streamTaskIdRef.current) return;
        const minutes = Math.round(elapsedMs / 60_000);
        updateParts((parts) => {
          parts.push({
            type: "text",
            text: `⏱ CI 运行 #${runId} 在 ${minutes} 分钟内未完成,已停止跟踪。可调用 listCIRuns 手动查询。`,
          });
          return parts;
        });
      },
    );

    // M13: subscribeAfterDispatch couldn't resolve a runId for a manual
    // workflow_dispatch within the 6s retry budget — tell the user to fall
    // back to manual listing.
    const offCiDispatchResolveFailed =
      window.filework.onCiDispatchResolveFailed(({ id, ref, workflowFile }) => {
        if (id !== streamTaskIdRef.current) return;
        updateParts((parts) => {
          parts.push({
            type: "text",
            text: `⚠️ 已 dispatch ${workflowFile} on ${ref},但未能识别新 run id (GitHub 可能尚未创建);可调用 githubListWorkflowRuns 手动查询。`,
          });
          return parts;
        });
      });

    return () => {
      offStart();
      offSkillActivated();
      offDelta();
      offToolCall();
      offToolResult();
      offToolApproval();
      offRetry();
      offDone();
      offError();
      offClarification();
      offSkillApprovalRequest();
      offCiRunDone();
      offCiRunTimeout();
      offCiDispatchResolveFailed();
    };
  }, [
    debouncedSave,
    LL,
    setMessages,
    setLastUsage,
    setLastError,
    activeSessionIdRef,
  ]);

  return {
    isLoading,
    setIsLoading,
    activeSkill,
    setActiveSkill,
    pendingSkillApproval,
    setPendingSkillApproval,
    retryInfo,
    setRetryInfo,
    isStalled,
    setIsStalled,
    streamTaskIdRef,
    streamAssistantIdRef,
    pendingStopRef,
    stopRequestedRef,
    connectionTimeoutRef,
  };
}
