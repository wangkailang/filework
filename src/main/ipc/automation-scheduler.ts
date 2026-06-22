import {
  type AutomationRecord,
  type AutomationRunRecord,
  listDueAutomations,
  queueAutomationRun,
  recoverInterruptedAutomationRuns,
} from "../db";

interface AutomationSchedulerDeps {
  listDueAutomations?: (now: Date) => AutomationRecord[];
  queueAutomationRun?: (
    automationId: string,
    input: { trigger: "manual" | "scheduled"; now: Date },
  ) => Pick<AutomationRunRecord, "id" | "automationId">;
  recoverInterruptedRuns?: (now: Date) => AutomationRunRecord[];
  runAutomationRun: (runId: string) => Promise<unknown>;
  now?: () => Date;
  intervalMs?: number;
  onRecoveredRun?: (run: AutomationRunRecord) => void;
  onError?: (error: unknown) => void;
}

export interface AutomationScheduler {
  tick: () => Promise<void>;
  triggerNow: (
    automationId: string,
  ) => Promise<Pick<AutomationRunRecord, "id" | "automationId">>;
  start: () => void;
  stop: () => void;
}

export const createAutomationScheduler = ({
  listDueAutomations: listDue = listDueAutomations,
  queueAutomationRun: queueRun = queueAutomationRun,
  recoverInterruptedRuns = recoverInterruptedAutomationRuns,
  runAutomationRun,
  now = () => new Date(),
  intervalMs = 60_000,
  onRecoveredRun = () => undefined,
  onError = (error) => {
    console.error("[automation-scheduler]", error);
  },
}: AutomationSchedulerDeps): AutomationScheduler => {
  let timer: ReturnType<typeof setInterval> | null = null;
  const inFlightAutomationIds = new Set<string>();

  const launch = (
    run: Pick<AutomationRunRecord, "id" | "automationId">,
  ): void => {
    if (inFlightAutomationIds.has(run.automationId)) return;
    inFlightAutomationIds.add(run.automationId);
    void runAutomationRun(run.id)
      .catch(onError)
      .finally(() => {
        inFlightAutomationIds.delete(run.automationId);
      });
  };

  const tick = async (): Promise<void> => {
    const tickNow = now();
    for (const automation of listDue(tickNow)) {
      if (inFlightAutomationIds.has(automation.id)) continue;
      try {
        const run = queueRun(automation.id, {
          trigger: "scheduled",
          now: tickNow,
        });
        launch(run);
      } catch (error) {
        onError(error);
      }
    }
  };

  const triggerNow = async (
    automationId: string,
  ): Promise<Pick<AutomationRunRecord, "id" | "automationId">> => {
    const run = queueRun(automationId, { trigger: "manual", now: now() });
    launch(run);
    return run;
  };

  return {
    tick,
    triggerNow,
    start: () => {
      if (timer) return;
      timer = setInterval(() => {
        void tick();
      }, intervalMs);
      try {
        for (const run of recoverInterruptedRuns(now())) {
          onRecoveredRun(run);
        }
      } catch (error) {
        onError(error);
      }
      void tick();
    },
    stop: () => {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },
  };
};
