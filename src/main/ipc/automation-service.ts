import {
  type AutomationRunRecord,
  continueAutomationRun as continueAutomationRunRecord,
  finishAutomationRun,
  getAutomation,
  getAutomationRun,
  queueAutomationRun,
} from "../db";
import { notifyAutomationRunAttention } from "./automation-notifications";
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
    const finished = finishAutomationRun(run.id, {
      status: "failed",
      errorMessage: `Automation not found: ${run.automationId}`,
    });
    notifyAutomationRunAttention(finished);
    return finished;
  }

  const finished = await runAutomationHeadless(run, automation);
  notifyAutomationRunAttention(finished);
  return finished;
};

export const rerunAutomationRun = async (
  runId: string,
): Promise<Pick<AutomationRunRecord, "id" | "automationId">> => {
  const run = getAutomationRun(runId);
  if (!run) throw new Error(`Automation run not found: ${runId}`);
  const automation = getAutomation(run.automationId);
  if (!automation) {
    throw new Error(`Automation not found: ${run.automationId}`);
  }
  return scheduler.triggerNow(automation.id);
};

export const continueAutomationRun = async (
  runId: string,
): Promise<AutomationRunRecord> => {
  const run = continueAutomationRunRecord(runId);
  void runAutomationRun(run.id);
  return run;
};

export const prepareAutomationChatRun = (
  automationId: string,
  input: { assistantMessageId: string; sessionId: string },
): AutomationRunRecord =>
  queueAutomationRun(automationId, {
    assistantMessageId: input.assistantMessageId,
    chatSessionId: input.sessionId,
    trigger: "manual",
  });

const scheduler = createAutomationScheduler({
  onRecoveredRun: notifyAutomationRunAttention,
  runAutomationRun,
});

export const triggerAutomationNow = (automationId: string) =>
  scheduler.triggerNow(automationId);

export const startAutomationScheduler = (): AutomationScheduler => {
  scheduler.start();
  return scheduler;
};

export const stopAutomationScheduler = (): void => {
  scheduler.stop();
};
