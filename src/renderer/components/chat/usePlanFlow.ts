import { type MutableRefObject, useCallback, useEffect, useState } from "react";
import { useI18nContext } from "../../i18n/i18n-react";
import type { PlanStepView, PlanView } from "../ai-elements/plan-viewer";
import type { ChatMessage, MessagePart, PlanMessagePart } from "./types";

interface PlanFlowDeps {
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  setIsLoading: React.Dispatch<React.SetStateAction<boolean>>;
  debouncedSave: (msgs: ChatMessage[], sessionId: string) => void;
  activeSessionIdRef: MutableRefObject<string | null>;
  streamTaskIdRef: MutableRefObject<string | null>;
  streamAssistantIdRef: MutableRefObject<string | null>;
  pendingStopRef: MutableRefObject<boolean>;
}

export function usePlanFlow({
  setMessages,
  setIsLoading,
  debouncedSave,
  activeSessionIdRef,
  streamTaskIdRef,
  streamAssistantIdRef,
  pendingStopRef,
}: PlanFlowDeps) {
  const { LL } = useI18nContext();
  const [isPlanGenerating, setIsPlanGenerating] = useState(false);
  const [activePlanId, setActivePlanId] = useState<string | null>(null);
  const [isStalled, setIsStalled] = useState(false);

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
    [setMessages],
  );

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
          content: `${LL.chat_planExecution(planView.goal)}`,
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
        const errText = LL.chat_planFailed(String(error));
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

    const offSubStepProgress = window.filework.onPlanSubStepProgress(
      ({ planId, stepId, completed }) => {
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

    const offStepArtifacts = window.filework.onPlanStepArtifacts(
      ({ planId, stepId, artifacts }) => {
        updatePlanStep(planId, stepId, {
          artifacts: artifacts as PlanStepView["artifacts"],
        });
      },
    );

    const offStepArtifact = window.filework.onPlanStepArtifact(
      ({ planId, stepId, artifact }) => {
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
            const newSteps = planPart.plan.steps.map((s) => {
              if (s.id !== stepId) return s;
              const existing = s.artifacts ?? [];
              if (existing.some((a) => a.toolCallId === artifact.toolCallId))
                return s;
              return {
                ...s,
                artifacts: [
                  ...existing,
                  artifact as NonNullable<PlanStepView["artifacts"]>[number],
                ],
              };
            });
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
      offStepArtifact();
      offWatchdog();
    };
  }, [
    debouncedSave,
    updatePlanStep,
    LL,
    setMessages,
    setIsLoading,
    activeSessionIdRef,
    streamTaskIdRef,
    streamAssistantIdRef,
  ]);

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

  return {
    isPlanGenerating,
    setIsPlanGenerating,
    activePlanId,
    isStalled,
    handleApprovePlan,
    handleRejectPlan,
    handleCancelPlan,
  };
}
