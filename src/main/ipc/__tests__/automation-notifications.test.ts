import { describe, expect, it, vi } from "vitest";

import { createAutomationRunNotifier } from "../automation-notifications";

const failedRun = {
  id: "run-1",
  automationId: "auto-1",
  automationTitle: "Daily repo check",
  trigger: "scheduled" as const,
  status: "failed" as const,
  triageStatus: "open" as const,
  needsActionReason: null,
  chatSessionId: null,
  assistantMessageId: null,
  taskId: null,
  prompt: "Check repo",
  workspacePaths: ["/workspace"],
  threadId: null,
  modelId: null,
  output: null,
  errorMessage: "Command failed",
  inputTokens: null,
  outputTokens: null,
  totalTokens: null,
  retryCount: 0,
  maxAttempts: 3,
  nextRetryAt: null,
  createdAt: "2026-06-18T03:00:00.000Z",
  updatedAt: "2026-06-18T03:01:00.000Z",
  startedAt: "2026-06-18T03:00:05.000Z",
  completedAt: "2026-06-18T03:01:00.000Z",
};

describe("automation notifications", () => {
  it("shows a desktop notification for failed and needs-action runs", () => {
    const show = vi.fn();
    const notificationCtor = vi.fn(() => ({ show }));
    const notify = createAutomationRunNotifier({
      Notification: notificationCtor,
      isSupported: () => true,
    });

    notify(failedRun);
    notify({
      ...failedRun,
      id: "run-2",
      status: "needs_action",
      needsActionReason: "Requires approval",
      errorMessage: "Requires approval",
      completedAt: null,
    });

    expect(notificationCtor).toHaveBeenCalledTimes(2);
    expect(notificationCtor).toHaveBeenNthCalledWith(1, {
      title: "自动化运行失败",
      body: "Daily repo check: Command failed",
    });
    expect(notificationCtor).toHaveBeenNthCalledWith(2, {
      title: "自动化需要处理",
      body: "Daily repo check: Requires approval",
    });
    expect(show).toHaveBeenCalledTimes(2);
  });

  it("does not notify for successful runs", () => {
    const notificationCtor = vi.fn(() => ({ show: vi.fn() }));
    const notify = createAutomationRunNotifier({
      Notification: notificationCtor,
      isSupported: () => true,
    });

    notify({ ...failedRun, status: "succeeded", errorMessage: null });

    expect(notificationCtor).not.toHaveBeenCalled();
  });

  it("uses localized notification titles and fallback body text", () => {
    const notificationCtor = vi.fn(() => ({ show: vi.fn() }));
    const notifyEn = createAutomationRunNotifier({
      Notification: notificationCtor,
      getLocale: () => "en",
      isSupported: () => true,
    });
    const notifyJa = createAutomationRunNotifier({
      Notification: notificationCtor,
      getLocale: () => "ja",
      isSupported: () => true,
    });

    notifyEn({ ...failedRun, errorMessage: null });
    notifyJa({
      ...failedRun,
      id: "run-3",
      status: "needs_action",
      errorMessage: null,
      needsActionReason: null,
    });

    expect(notificationCtor).toHaveBeenNthCalledWith(1, {
      title: "Automation run failed",
      body: "Daily repo check: Open Triage for details",
    });
    expect(notificationCtor).toHaveBeenNthCalledWith(2, {
      title: "自動化の対応が必要です",
      body: "Daily repo check: Triage で詳細を確認してください",
    });
  });

  it("invokes the run click handler when the user opens the notification", () => {
    const clickHandlers: Array<() => void> = [];
    const show = vi.fn();
    const on = vi.fn((event: string, handler: () => void) => {
      if (event === "click") clickHandlers.push(handler);
    });
    const notificationCtor = vi.fn(() => ({ on, show }));
    const onClick = vi.fn();
    const notify = createAutomationRunNotifier({
      Notification: notificationCtor,
      isSupported: () => true,
      onClick,
    });

    notify(failedRun);
    clickHandlers[0]?.();

    expect(on).toHaveBeenCalledWith("click", expect.any(Function));
    expect(show).toHaveBeenCalledTimes(1);
    expect(onClick).toHaveBeenCalledWith(failedRun);
  });
});
