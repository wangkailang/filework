import {
  type AutomationRunRecord,
  finishAutomationRun,
  getAutomation,
  getAutomationRun,
} from "../db";
import { runAutomationHeadless } from "./automation-runner";
import {
  type AutomationScheduler,
  createAutomationScheduler,
} from "./automation-scheduler";

export const runAutomationRun = async (
  runId: string,
): Promise<AutomationRunRecord | null> => {
  const run = getAutomationRun(runId);
  if (!run) return null;

  const automation = getAutomation(run.automationId);
  if (!automation) {
    return finishAutomationRun(run.id, {
      status: "failed",
      errorMessage: `Automation not found: ${run.automationId}`,
    });
  }

  return runAutomationHeadless(run, automation);
};

const scheduler = createAutomationScheduler({ runAutomationRun });

export const triggerAutomationNow = (automationId: string) =>
  scheduler.triggerNow(automationId);

export const startAutomationScheduler = (): AutomationScheduler => {
  scheduler.start();
  return scheduler;
};

export const stopAutomationScheduler = (): void => {
  scheduler.stop();
};
