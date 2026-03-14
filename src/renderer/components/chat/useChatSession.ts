import { useCallback, useEffect, useRef, useState } from "react";
import type { ApprovalState } from "../ai-elements/confirmation";
import type { PlanView, PlanStepView } from "../ai-elements/plan-viewer";
import type {
  ActiveSkillInfo,
  ChatMessage,
  ChatSession,
  MessagePart,
  PlanMessagePart,
  ToolApproval,
  ToolPart,
} from "./types";
import type { SkillApprovalData } from "./SkillApprovalDialog";
import { contentFromParts, migrateToParts, truncateTitle } from "./helpers";

export function useChatSession(workspacePath: string) {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isPlanGenerating, setIsPlanGenerating] = useState(false);
  const [activePlanId, setActivePlanId] = useState<string | null>(null);
  const [activeSkill, setActiveSkill] = useState<ActiveSkillInfo | null>(null);
  const [pendingSkillApproval, setPendingSkillApproval] = useState<SkillApprovalData | null>(null);
  const [selectedLlmConfigId, setSelectedLlmConfigId] = useState<string | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const streamTaskIdRef = useRef<string | null>(null);
  const streamAssistantIdRef = useRef<string | null>(null);
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
  // Load sessions when workspace changes
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const load = async () => {
      try {
        const list: ChatSession[] = await window.filework.getChatSessions(workspacePath);
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
        window.filework.saveChatHistory(activeSessionId, workspacePath, messages);
      }
    };
  }, [workspacePath, messages, activeSessionId]);

  // ---------------------------------------------------------------------------
  // Stream event listeners
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const offStart = window.filework.onStreamStart(({ id }) => {
      streamTaskIdRef.current = id;
    });

    const offSkillActivated = window.filework.onSkillActivated(
      ({ id, skillId, skillName, source }) => {
        if (id !== streamTaskIdRef.current) return;
        setActiveSkill({ skillId, skillName, source });
      },
    );

    const updateParts = (updater: (parts: MessagePart[]) => MessagePart[]) => {
      setMessages((prev) => {
        const idx = prev.findIndex((m) => m.id === streamAssistantIdRef.current);
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

    const offToolCall = window.filework.onStreamToolCall(({ id, toolCallId, toolName, args }) => {
      if (id !== streamTaskIdRef.current) return;
      updateParts((parts) => {
        const existingIdx = parts.findIndex(
          (p) => p.type === "tool" && p.toolCallId === toolCallId,
        );
        if (existingIdx !== -1) {
          parts[existingIdx] = { ...(parts[existingIdx] as ToolPart), args };
        } else {
          parts.push({ type: "tool", toolCallId, toolName, args, state: "input-available" });
        }
        return parts;
      });
    });

    const offToolResult = window.filework.onStreamToolResult(({ id, toolCallId, result }) => {
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
                  state: (isDenied ? "approval-rejected" : "approval-accepted") as ApprovalState,
                }
              : undefined,
          };
        });
      });
    });

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
            parts[existingIdx] = { ...(parts[existingIdx] as ToolPart), approval };
          } else {
            parts.push({ type: "tool", toolCallId, toolName, args, state: "input-available", approval });
          }
          return parts;
        });
      },
    );

    const offDone = window.filework.onStreamDone(({ id }) => {
      if (id !== streamTaskIdRef.current) return;
      streamTaskIdRef.current = null;
      streamAssistantIdRef.current = null;
      setIsLoading(false);
      setActiveSkill(null);
      setMessages((prev) => {
        if (activeSessionIdRef.current) {
          debouncedSave(prev, activeSessionIdRef.current);
        }
        return prev;
      });
    });

    const offError = window.filework.onStreamError(({ id, error }) => {
      if (id !== streamTaskIdRef.current) return;
      streamTaskIdRef.current = null;
      setIsLoading(false);
      setActiveSkill(null);
      setMessages((prev) => {
        const idx = prev.findIndex((m) => m.id === streamAssistantIdRef.current);
        if (idx === -1) return prev;
        const updated = [...prev];
        const msg = updated[idx];
        const fallbackText = msg.content || `出错了: ${error}`;
        updated[idx] = {
          ...msg,
          content: fallbackText,
          parts: msg.parts && msg.parts.length > 0 ? msg.parts : [{ type: "text", text: fallbackText }],
        };
        streamAssistantIdRef.current = null;
        if (activeSessionIdRef.current) {
          debouncedSave(updated, activeSessionIdRef.current);
        }
        return updated;
      });
    });

    const offSkillApprovalRequest = window.filework.onSkillApprovalRequest((data) => {
      setPendingSkillApproval(data);
    });

    return () => {
      offStart();
      offSkillActivated();
      offDelta();
      offToolCall();
      offToolResult();
      offToolApproval();
      offDone();
      offError();
      offSkillApprovalRequest();
    };
  }, [debouncedSave]);

  // ---------------------------------------------------------------------------
  // Plan step updater
  // ---------------------------------------------------------------------------
  const updatePlanStep = (
    planId: string,
    stepId: number,
    updates: Partial<PlanStepView>,
  ) => {
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
        else if (newSteps.some((s) => s.status === "running")) planStatus = "executing";

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
  };

  // ---------------------------------------------------------------------------
  // Planner event listeners
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const offPlanReady = window.filework.onPlanReady(({ plan }) => {
      setIsPlanGenerating(false);
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
        updated[idx] = { ...msg, parts: newParts, content: `执行计划: ${planView.goal}` };
        return updated;
      });
    });

    const offPlanError = window.filework.onPlanError(({ error }) => {
      setIsPlanGenerating(false);
      setIsLoading(false);
      setMessages((prev) => {
        const assistantId = streamAssistantIdRef.current;
        const idx = prev.findIndex((m) => m.id === assistantId);
        if (idx === -1) return prev;
        const updated = [...prev];
        const msg = updated[idx];
        const errText = `计划生成失败: ${error}`;
        updated[idx] = { ...msg, content: errText, parts: [{ type: "text", text: errText }] };
        streamAssistantIdRef.current = null;
        return updated;
      });
    });

    const offStepStart = window.filework.onPlanStepStart(({ planId, stepId }) => {
      updatePlanStep(planId, stepId, { status: "running" });
    });

    const offStepDone = window.filework.onPlanStepDone(({ planId, stepId }) => {
      updatePlanStep(planId, stepId, { status: "completed" });
    });

    const offStepError = window.filework.onPlanStepError(({ planId, stepId, error }) => {
      updatePlanStep(planId, stepId, { status: "failed", error });
    });

    return () => {
      offPlanReady();
      offPlanError();
      offStepStart();
      offStepDone();
      offStepError();
    };
  }, []);

  // ---------------------------------------------------------------------------
  // Plan approval / rejection
  // ---------------------------------------------------------------------------
  const handleApprovePlan = async (planId: string) => {
    setActivePlanId(null);
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
    const session: ChatSession = await window.filework.createChatSession(workspacePath);
    setSessions((prev) => [session, ...prev]);
    setActiveSessionId(session.id);
    setMessages([]);
    return session.id;
  };

  const handleNewChat = async () => {
    if (isLoading) return;
    await createNewSession();
  };

  const handleSelectSession = (sessionId: string) => {
    if (isLoading || sessionId === activeSessionId) return;
    setActiveSessionId(sessionId);
    setSelectedLlmConfigId(null);
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
      .filter(m => m.id !== assistantId)  // Exclude current placeholder
      .map(({ role, content, parts }) => ({
        role,
        content,
        parts: parts?.filter(p => p.type !== "plan"),  // Exclude PlanMessagePart
      }));

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
        const errText = `出错了: ${error instanceof Error ? error.message : "未知错误"}`;
        setMessages((prev) => {
          const idx = prev.findIndex((m) => m.id === assistantId);
          if (idx === -1) return prev;
          const updated = [...prev];
          updated[idx] = {
            ...updated[idx],
            content: errText,
            parts: [{ type: "text", text: errText }],
          };
          if (activeSessionIdRef.current) {
            debouncedSave(updated, activeSessionIdRef.current);
          }
          return updated;
        });
        setIsLoading(false);
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
        if (p.type !== "tool" || p.toolCallId !== toolCallId || !p.approval) return p;
        return {
          ...p,
          approval: {
            ...p.approval,
            state: (approved ? "approval-accepted" : "approval-rejected") as ApprovalState,
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
    if (!taskId) return;
    window.filework.stopGeneration(taskId);
  }, []);

  const handleSkillApproval = (approved: boolean) => {
    if (!pendingSkillApproval) return;
    window.filework.approveSkill({ skillId: pendingSkillApproval.skillId, approved });
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
    setSelectedLlmConfigId,
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
