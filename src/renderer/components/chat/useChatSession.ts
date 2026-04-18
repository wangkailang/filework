import { useCallback, useEffect, useRef, useState } from "react";
import type { ApprovalState } from "../ai-elements/confirmation";
import type { PlanStepView, PlanView } from "../ai-elements/plan-viewer";
import { contentFromParts, migrateToParts, truncateTitle } from "./helpers";
import type { SkillApprovalData } from "./SkillApprovalDialog";
import type {
  ActiveSkillInfo,
  ChatMessage,
  ChatSession,
  MessagePart,
  PlanMessagePart,
  ToolApproval,
  ToolPart,
  UsagePart,
} from "./types";

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
}

export function useChatSession(workspacePath: string) {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isPlanGenerating, setIsPlanGenerating] = useState(false);
  const [activePlanId, setActivePlanId] = useState<string | null>(null);
  const [activeSkill, setActiveSkill] = useState<ActiveSkillInfo | null>(null);
  const [pendingSkillApproval, setPendingSkillApproval] =
    useState<SkillApprovalData | null>(null);
  const [selectedLlmConfigId, setSelectedLlmConfigId] = useState<string | null>(
    () => localStorage.getItem("filework-selected-llm-config") || null,
  );
  const [retryInfo, setRetryInfo] = useState<RetryInfo | null>(null);
  const [lastUsage, setLastUsage] = useState<UsageInfo | null>(null);
  const [lastError, setLastError] = useState<StreamErrorInfo | null>(null);
  const [isStalled, setIsStalled] = useState(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const streamTaskIdRef = useRef<string | null>(null);
  const streamAssistantIdRef = useRef<string | null>(null);
  const pendingStopRef = useRef(false);
  const stopRequestedRef = useRef(false);
  const connectionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const activeSessionIdRef = useRef<string | null>(null);
  activeSessionIdRef.current = activeSessionId;

  // ---------------------------------------------------------------------------
  // Debounced save
  // ---------------------------------------------------------------------------
  const debouncedSave = useCallback(
    (msgs: ChatMessage[], sessionId: string) => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        window.filework.saveChatHistory(sessionId, workspacePath, msgs);
      }, 500);
    },
    [workspacePath],
  );

  // ---------------------------------------------------------------------------
  // Validate persisted LLM config ID on mount
  // ---------------------------------------------------------------------------
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

  // ---------------------------------------------------------------------------
  // Load sessions when workspace changes
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const load = async () => {
      try {
        const list: ChatSession[] =
          await window.filework.getChatSessions(workspacePath);
        setSessions(list);
        if (list.length > 0) {
          setActiveSessionId(list[0].id);
        } else {
          setActiveSessionId(null);
          setMessages([]);
        }
      } catch {
        setSessions([]);
        setActiveSessionId(null);
        setMessages([]);
      }
    };
    load();
  }, [workspacePath]);

  // ---------------------------------------------------------------------------
  // Load messages when active session changes
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!activeSessionId) {
      setMessages([]);
      return;
    }
    const load = async () => {
      try {
        const history = await window.filework.getChatHistory(activeSessionId);
        const migrated = (history ?? []).map((m: ChatMessage) =>
          m.role === "assistant" ? { ...m, parts: migrateToParts(m) } : m,
        );
        setMessages(migrated);

        // Restore lastUsage from the last assistant message's UsagePart
        for (let i = migrated.length - 1; i >= 0; i--) {
          const msg = migrated[i];
          if (msg.role !== "assistant" || !msg.parts) continue;
          const usagePart = msg.parts.find(
            (p: MessagePart) => p.type === "usage",
          ) as UsagePart | undefined;
          if (usagePart) {
            setLastUsage({
              inputTokens: usagePart.inputTokens,
              outputTokens: usagePart.outputTokens,
              totalTokens: usagePart.totalTokens,
              modelId: usagePart.modelId,
              provider: usagePart.provider,
            });
            break;
          }
        }
      } catch {
        setMessages([]);
      }
    };
    load();
  }, [activeSessionId]);

  // Save on unmount / workspace switch
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      if (messages.length > 0 && activeSessionId) {
        window.filework.saveChatHistory(
          activeSessionId,
          workspacePath,
          messages,
        );
      }
    };
  }, [workspacePath, messages, activeSessionId]);

  // ---------------------------------------------------------------------------
  // Stream event listeners
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const offStart = window.filework.onStreamStart(({ id }) => {
      console.log("[Stream Start] Setting taskId:", id);
      streamTaskIdRef.current = id;
      setIsStalled(false);
      // Connection established – cancel the timeout guard
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
      ({ id, toolCallId, toolName, args, description }) => {
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

      // Normalize stopped-by-user tool parts first
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
                reason: "用户已停止执行",
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

      // Fetch usage for this task and persist as a UsagePart
      window.filework.usage
        .getTaskUsage(id)
        .then((usage: UsageInfo | null) => {
          if (usage && usage.totalTokens != null) {
            setLastUsage(usage);
            // Append usage part to the assistant message so it persists
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
            // No usage data — still save current messages
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

    const offError = window.filework.onStreamError(({ id, error, type }) => {
      // Relaxed matching: accept error when taskId matches, OR when no taskId
      // is set yet but we are actively loading (race between stream-start and
      // stream-error events).
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
      setLastError({ message: error, type });
      setMessages((prev) => {
        const idx = prev.findIndex((m) => m.id === assistantId);
        if (idx === -1) return prev;
        const updated = [...prev];
        const msg = updated[idx];
        // Append an error part so the error is visible inline in the conversation
        const errorPart: MessagePart = {
          type: "error",
          message: error,
          errorType: type,
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
    });

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
      offSkillApprovalRequest();
    };
  }, [debouncedSave]);

  // ---------------------------------------------------------------------------
  // Plan step updater
  // ---------------------------------------------------------------------------
  const updatePlanStep = useCallback(
    (planId: string, stepId: number, updates: Partial<PlanStepView>) => {
      setMessages((prev) => {
        const updated = [...prev];
        for (let i = updated.length - 1; i >= 0; i--) {
          const msg = updated[i];
          if (!msg.parts) continue;
          const planPartIdx = msg.parts.findIndex(
            (p) =>
              p.type === "plan" && (p as PlanMessagePart).plan.id === planId,
          );
          if (planPartIdx === -1) continue;

          const planPart = msg.parts[planPartIdx] as PlanMessagePart;
          const newSteps = planPart.plan.steps.map((s) =>
            s.id === stepId ? { ...s, ...updates } : s,
          );
          const allDone = newSteps.every(
            (s) => s.status === "completed" || s.status === "skipped",
          );
          const anyFailed = newSteps.some((s) => s.status === "failed");
          let planStatus = planPart.plan.status;
          if (allDone) planStatus = "completed";
          else if (anyFailed) planStatus = "failed";
          else if (newSteps.some((s) => s.status === "running"))
            planStatus = "executing";

          const newParts = [...msg.parts];
          newParts[planPartIdx] = {
            type: "plan",
            plan: { ...planPart.plan, steps: newSteps, status: planStatus },
          };
          updated[i] = { ...msg, parts: newParts };
          break;
        }
        return updated;
      });
    },
    [],
  );

  // ---------------------------------------------------------------------------
  // Planner event listeners
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const offPlanReady = window.filework.onPlanReady(({ id, plan }) => {
      if (id && id !== streamTaskIdRef.current) return;
      setIsPlanGenerating(false);
      setIsLoading(false);
      const planView = plan as PlanView;
      setActivePlanId(planView.id);

      setMessages((prev) => {
        const assistantId = streamAssistantIdRef.current;
        const idx = prev.findIndex((m) => m.id === assistantId);
        if (idx === -1) return prev;
        const updated = [...prev];
        const msg = updated[idx];
        const newParts: MessagePart[] = [
          ...(msg.parts ?? []),
          { type: "plan", plan: planView },
        ];
        updated[idx] = {
          ...msg,
          parts: newParts,
          content: `执行计划: ${planView.goal}`,
        };
        return updated;
      });
    });

    const offPlanError = window.filework.onPlanError(({ id, error }) => {
      if (id && id !== streamTaskIdRef.current) return;
      setIsPlanGenerating(false);
      setIsLoading(false);
      setMessages((prev) => {
        const assistantId = streamAssistantIdRef.current;
        const idx = prev.findIndex((m) => m.id === assistantId);
        if (idx === -1) return prev;
        const updated = [...prev];
        const msg = updated[idx];
        const errText = `计划生成失败: ${error}`;
        updated[idx] = {
          ...msg,
          content: errText,
          parts: [{ type: "text", text: errText }],
        };
        if (activeSessionIdRef.current) {
          debouncedSave(updated, activeSessionIdRef.current);
        }
        return updated;
      });
    });

    const offStepStart = window.filework.onPlanStepStart(
      ({ planId, stepId }) => {
        updatePlanStep(planId, stepId, { status: "running" });
      },
    );

    const offStepDone = window.filework.onPlanStepDone(({ planId, stepId }) => {
      updatePlanStep(planId, stepId, { status: "completed" });
    });

    const offStepError = window.filework.onPlanStepError(
      ({ planId, stepId, error }) => {
        updatePlanStep(planId, stepId, { status: "failed", error });
      },
    );

    // Sub-step progress — mark sub-steps as done proportionally
    const offSubStepProgress = window.filework.onPlanSubStepProgress(
      ({ planId, stepId, completed }) => {
        // Use setMessages directly with a single pass to avoid the double-render
        // that would occur from wrapping updatePlanStep inside another setMessages.
        setMessages((prev) => {
          const updated = [...prev];
          for (let i = updated.length - 1; i >= 0; i--) {
            const msg = updated[i];
            if (!msg.parts) continue;
            const planPartIdx = msg.parts.findIndex(
              (p) =>
                p.type === "plan" && (p as PlanMessagePart).plan.id === planId,
            );
            if (planPartIdx === -1) continue;

            const planPart = msg.parts[planPartIdx] as PlanMessagePart;
            const step = planPart.plan.steps.find((s) => s.id === stepId);
            if (!step?.subSteps) break;

            const newSubSteps = step.subSteps.map((ss, idx) => ({
              ...ss,
              status: (idx < completed ? "done" : "pending") as
                | "done"
                | "pending",
            }));

            const newSteps = planPart.plan.steps.map((s) =>
              s.id === stepId ? { ...s, subSteps: newSubSteps } : s,
            );
            const newParts = [...msg.parts];
            newParts[planPartIdx] = {
              type: "plan",
              plan: { ...planPart.plan, steps: newSteps },
            };
            updated[i] = { ...msg, parts: newParts };
            break;
          }
          return updated;
        });
      },
    );

    // Step artifacts — attach artifacts to step when step completes
    const offStepArtifacts = window.filework.onPlanStepArtifacts(
      ({ planId, stepId, artifacts }) => {
        updatePlanStep(planId, stepId, {
          artifacts: artifacts as PlanStepView["artifacts"],
        });
      },
    );

    // Watchdog events — track stall state for UI indicators
    const offWatchdog = window.filework.onWatchdog(({ taskId, type }) => {
      if (taskId !== streamTaskIdRef.current) return;
      if (type === "stall-warning") {
        setIsStalled(true);
      } else if (type === "stall-recovered" || type === "stall-timeout") {
        setIsStalled(false);
      }
    });

    return () => {
      offPlanReady();
      offPlanError();
      offStepStart();
      offStepDone();
      offStepError();
      offSubStepProgress();
      offStepArtifacts();
      offWatchdog();
    };
  }, [debouncedSave, updatePlanStep]);

  // ---------------------------------------------------------------------------
  // Plan approval / rejection
  // ---------------------------------------------------------------------------
  const handleApprovePlan = async (planId: string) => {
    setActivePlanId(null);
    setIsLoading(true);
    pendingStopRef.current = false;
    setMessages((prev) => {
      const updated = [...prev];
      for (let i = updated.length - 1; i >= 0; i--) {
        const msg = updated[i];
        if (!msg.parts) continue;
        const planPartIdx = msg.parts.findIndex(
          (p) => p.type === "plan" && (p as PlanMessagePart).plan.id === planId,
        );
        if (planPartIdx === -1) continue;
        const planPart = msg.parts[planPartIdx] as PlanMessagePart;
        const newParts = [...msg.parts];
        newParts[planPartIdx] = {
          type: "plan",
          plan: { ...planPart.plan, status: "executing" },
        };
        updated[i] = { ...msg, parts: newParts };
        break;
      }
      return updated;
    });
    window.filework.approvePlan(planId);
  };

  const handleRejectPlan = async (planId: string) => {
    setActivePlanId(null);
    setIsLoading(false);
    streamAssistantIdRef.current = null;
    setMessages((prev) => {
      const updated = [...prev];
      for (let i = updated.length - 1; i >= 0; i--) {
        const msg = updated[i];
        if (!msg.parts) continue;
        const planPartIdx = msg.parts.findIndex(
          (p) => p.type === "plan" && (p as PlanMessagePart).plan.id === planId,
        );
        if (planPartIdx === -1) continue;
        const planPart = msg.parts[planPartIdx] as PlanMessagePart;
        const newParts = [...msg.parts];
        newParts[planPartIdx] = {
          type: "plan",
          plan: { ...planPart.plan, status: "cancelled" },
        };
        updated[i] = { ...msg, parts: newParts };
        break;
      }
      return updated;
    });
    window.filework.rejectPlan(planId);
  };

  const handleCancelPlan = (planId: string) => {
    window.filework.cancelPlan(planId);
  };

  // ---------------------------------------------------------------------------
  // Session management
  // ---------------------------------------------------------------------------
  const createNewSession = async (): Promise<string> => {
    const session: ChatSession =
      await window.filework.createChatSession(workspacePath);
    setSessions((prev) => [session, ...prev]);
    setActiveSessionId(session.id);
    setMessages([]);
    return session.id;
  };

  const handleNewChat = async () => {
    if (isLoading) return;
    setLastUsage(null);
    setLastError(null);
    await createNewSession();
  };

  const handleSelectSession = (sessionId: string) => {
    if (isLoading || sessionId === activeSessionId) return;
    setActiveSessionId(sessionId);
    setSelectedLlmConfigId(null);
    setLastUsage(null);
    setLastError(null);
  };

  const handleDeleteSession = async (sessionId: string) => {
    await window.filework.deleteChatSession(sessionId);
    setSessions((prev) => prev.filter((s) => s.id !== sessionId));
    if (sessionId === activeSessionId) {
      const remaining = sessions.filter((s) => s.id !== sessionId);
      if (remaining.length > 0) {
        setActiveSessionId(remaining[0].id);
      } else {
        setActiveSessionId(null);
        setMessages([]);
      }
    }
  };

  // ---------------------------------------------------------------------------
  // Submit & approval
  // ---------------------------------------------------------------------------
  const handleSubmit = async (message: { text: string }) => {
    const text = message.text.trim();
    if (!text || isLoading) return;

    setInput("");

    let sessionId = activeSessionId;
    if (!sessionId) {
      sessionId = await createNewSession();
    }

    const isFirstMessage = messages.length === 0;

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

    const withBoth = [...messages, userMessage, assistantMessage];
    setMessages(withBoth);
    debouncedSave(withBoth, sessionId);
    setIsLoading(true);
    setLastUsage(null);
    setLastError(null);
    setRetryInfo(null);
    pendingStopRef.current = false;
    stopRequestedRef.current = false;
    streamAssistantIdRef.current = assistantId;

    if (isFirstMessage) {
      const title = truncateTitle(text);
      window.filework.updateChatSession(sessionId, { title });
      setSessions((prev) =>
        prev.map((s) => (s.id === sessionId ? { ...s, title } : s)),
      );
    }

    // Extract history from messages, excluding the placeholder assistant message
    const history = withBoth
      .filter((m) => m.id !== assistantId) // Exclude current placeholder
      .map(({ role, content, parts }) => ({
        role,
        content,
        parts: parts?.filter((p) => p.type !== "plan"), // Exclude PlanMessagePart
      }));

    // Connection timeout guard: if no stream-start arrives within 30s, surface
    // an error instead of leaving the UI stuck in loading state.
    if (connectionTimeoutRef.current)
      clearTimeout(connectionTimeoutRef.current);
    connectionTimeoutRef.current = setTimeout(() => {
      if (
        streamAssistantIdRef.current === assistantId &&
        !streamTaskIdRef.current
      ) {
        const timeoutMsg = "连接超时，未能建立与 AI 服务的连接";
        const errorPart: MessagePart = {
          type: "error",
          message: timeoutMsg,
          errorType: "timeout",
        };
        setLastError({ message: timeoutMsg, type: "timeout" });
        setMessages((prev) => {
          const idx = prev.findIndex((m) => m.id === assistantId);
          if (idx === -1) return prev;
          const updated = [...prev];
          updated[idx] = {
            ...updated[idx],
            content: timeoutMsg,
            parts: [errorPart],
          };
          if (activeSessionIdRef.current) {
            debouncedSave(updated, activeSessionIdRef.current);
          }
          return updated;
        });
        setIsLoading(false);
        setRetryInfo(null);
        streamTaskIdRef.current = null;
        streamAssistantIdRef.current = null;
        connectionTimeoutRef.current = null;
      }
    }, 30_000);

    window.filework
      .checkNeedsPlanning({ prompt: userMessage.content })
      .then(({ needsPlanning: needs }: { needsPlanning: boolean }) => {
        if (needs) {
          setIsPlanGenerating(true);
          return window.filework.generatePlan({
            prompt: userMessage.content,
            workspacePath,
            llmConfigId: selectedLlmConfigId || undefined,
          });
        }
        return window.filework.executeTask({
          prompt: userMessage.content,
          workspacePath,
          llmConfigId: selectedLlmConfigId || undefined,
          history,
        });
      })
      .catch((error: unknown) => {
        if (streamAssistantIdRef.current !== assistantId) return;
        const errMsg = error instanceof Error ? error.message : "未知错误";
        const errorPart: MessagePart = {
          type: "error",
          message: errMsg,
        };
        setLastError({ message: errMsg });
        setMessages((prev) => {
          const idx = prev.findIndex((m) => m.id === assistantId);
          if (idx === -1) return prev;
          const updated = [...prev];
          updated[idx] = {
            ...updated[idx],
            content: errMsg,
            parts: [errorPart],
          };
          if (activeSessionIdRef.current) {
            debouncedSave(updated, activeSessionIdRef.current);
          }
          return updated;
        });
        setIsLoading(false);
        setRetryInfo(null);
        streamTaskIdRef.current = null;
        streamAssistantIdRef.current = null;
      });
  };

  const handleApproval = (toolCallId: string, approved: boolean) => {
    setMessages((prev) => {
      const assistantId = streamAssistantIdRef.current;
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

  // ---------------------------------------------------------------------------
  // Stop generation
  // ---------------------------------------------------------------------------
  const handleStopGeneration = useCallback(() => {
    const taskId = streamTaskIdRef.current;
    console.log(
      "[Stop Generation] Current taskId:",
      taskId,
      "isLoading:",
      isLoading,
    );
    stopRequestedRef.current = true;

    if (!taskId) {
      if (isLoading) {
        pendingStopRef.current = true;
      }
      console.warn(
        "[Stop Generation] No active taskId found, cannot stop generation because no task id is associated with the current stream",
      );
      // Do not force-reset UI or clear stream refs here; wait for a proper done/error event
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
        // Fallback: force UI state reset
        setIsLoading(false);
        setActiveSkill(null);
        streamTaskIdRef.current = null;
        streamAssistantIdRef.current = null;
      });
  }, [isLoading]);

  const handleSkillApproval = (approved: boolean) => {
    if (!pendingSkillApproval) return;
    window.filework.approveSkill({
      skillId: pendingSkillApproval.skillId,
      approved,
    });
    setPendingSkillApproval(null);
  };

  return {
    sessions,
    activeSessionId,
    messages,
    input,
    setInput,
    isLoading,
    isPlanGenerating,
    activePlanId,
    activeSkill,
    pendingSkillApproval,
    selectedLlmConfigId,
    setSelectedLlmConfigId: (id: string | null) => {
      setSelectedLlmConfigId(id);
      if (id) {
        localStorage.setItem("filework-selected-llm-config", id);
      } else {
        localStorage.removeItem("filework-selected-llm-config");
      }
    },
    retryInfo,
    lastUsage,
    lastError,
    isStalled,
    handleSubmit,
    handleApproval,
    handleSkillApproval,
    handleApprovePlan,
    handleRejectPlan,
    handleCancelPlan,
    handleStopGeneration,
    handleNewChat,
    handleSelectSession,
    handleDeleteSession,
  };
}
