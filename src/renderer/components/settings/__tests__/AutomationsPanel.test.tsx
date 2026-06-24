import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TranslationFunctions } from "../../../i18n/i18n-types";

vi.mock("../../../i18n/i18n-react", () => ({
  useI18nContext: () => ({
    locale: "zh-CN",
    LL: {
      automations_add: () => "新建自动化",
      automations_cancel: () => "取消",
      automations_createTitle: () => "新建自动化",
      automations_description: () =>
        "管理由 Agent 创建的定时任务、提醒和项目监控。",
      automations_delete: () => "删除",
      automations_deleteConfirmDesc: () =>
        "删除后不会再运行，确定删除这个自动化吗？",
      automations_deleteConfirmTitle: () => "删除自动化？",
      automations_disable: () => "停用",
      automations_edit: () => "编辑",
      automations_editTitle: () => "编辑自动化",
      automations_empty: () => "还没有自动化。",
      automations_enable: () => "启用",
      automations_enabled: () => "启用",
      automations_errorRequired: () => "名称、Prompt 和计划不能为空。",
      automations_loading: () => "正在加载自动化...",
      automations_lastRun: ({ value }: { value: string }) =>
        `上次运行 ${value}`,
      automations_modelId: () => "模型覆盖",
      automations_nextRun: ({ value }: { value: string }) =>
        `下次运行 ${value}`,
      automations_name: () => "名称",
      automations_notScheduled: () => "未计划",
      automations_prompt: () => "Prompt",
      automations_reasoningEffort: () => "推理强度",
      automations_runMode: () => "运行模式",
      automations_runModeLocal: () => "本地项目",
      automations_runModeWorktree: () => "隔离 worktree",
      automations_runCompleted: ({ value }: { value: string }) =>
        `完成 ${value}`,
      automations_runStarted: ({ value }: { value: string }) => `开始 ${value}`,
      automations_runCompletedLabel: () => "完成时间",
      automations_runStartedLabel: () => "开始时间",
      automations_runsEmpty: () => "暂无运行记录。",
      automations_runStatusCanceled: () => "已取消",
      automations_runStatusFailed: () => "失败",
      automations_runStatusNeedsAction: () => "等待处理",
      automations_runStatusQueued: () => "排队中",
      automations_runStatusRunning: () => "运行中",
      automations_runStatusSucceeded: () => "成功",
      automations_showTasks: () => "任务列表",
      automations_showTriage: () => "运行诊断",
      automations_scheduleCron: () => "Cron",
      automations_scheduleDaily: () => "每天",
      automations_scheduleDay: () => "星期",
      automations_scheduleEvery: () => "每",
      automations_scheduleInterval: () => "间隔",
      automations_scheduleKind: () => "计划类型",
      automations_schedulePreview: ({
        timeZone,
        value,
      }: {
        timeZone: string;
        value: string;
      }) => `预计下次执行 ${value}（${timeZone}）`,
      automations_schedulePreviewError: ({ value }: { value: string }) =>
        `计划无效：${value}`,
      automations_scheduleTime: () => "时间",
      automations_scheduleUnitDays: () => "天",
      automations_scheduleUnitHours: () => "小时",
      automations_scheduleUnitMinutes: () => "分钟",
      automations_scheduleValue: () => "计划值",
      automations_scheduleWeekly: () => "每周",
      automations_templateCiFailureTitle: () => "CI 失败跟踪",
      automations_templateDependenciesTitle: () => "依赖更新监控",
      automations_templateDailyCommitTitle: () => "每日 commit 统计",
      automations_templateUse: () => "使用模板",
      automations_templatesTitle: () => "推荐自动化",
      automations_tokenInput: ({ value }: { value: string }) =>
        `输入 ${value} tokens`,
      automations_tokenOutput: ({ value }: { value: string }) =>
        `输出 ${value} tokens`,
      automations_tokenTotal: ({ value }: { value: string }) =>
        `总计 ${value} tokens`,
      automations_triageFilterAll: () => "全部",
      automations_triageFilterHandled: () => "已处理",
      automations_triageFilterOpen: () => "待处理",
      automations_triageMarkHandled: () => "标记已处理",
      automations_triageContinueRun: () => "继续运行",
      automations_triageNextPage: () => "下一页",
      automations_triagePreviousPage: () => "上一页",
      automations_triageRerun: () => "重跑",
      automations_triageCancelRun: () => "取消运行",
      automations_triageCleanupHandled: () => "清理已处理",
      automations_triageCleanupOldHandled: () => "清理 30 天前",
      automations_viewDetails: () => "查看详情",
      automations_runDetailsTitle: () => "运行详情",
      automations_runDetailsOpenChat: () => "打开对话",
      automations_runDetailsPrompt: () => "执行指令",
      automations_runDetailsOutput: () => "输出",
      automations_runDetailsError: () => "错误",
      automations_runDetailsEvents: () => "执行事件",
      automations_runDetailsEmpty: () => "暂无输出",
      automations_runAttempt: ({
        current,
        max,
      }: {
        current: string;
        max: string;
      }) => `第 ${current}/${max} 次`,
      automations_runRetryAt: ({ value }: { value: string }) =>
        `下次重试 ${value}`,
      automations_save: () => "保存",
      automations_schedule: () => "计划",
      automations_statusDisabled: () => "已停用",
      automations_statusEnabled: () => "已启用",
      automations_trigger: () => "手动触发",
      automations_triggerManual: () => "手动",
      automations_triggerScheduled: () => "计划",
      automations_triggering: () => "触发中",
      automations_triageTitle: () => "运行诊断",
      automations_title: () => "自动化",
      automations_type: () => "类型",
      automations_typeProject: () => "项目",
      automations_typeStandalone: () => "独立",
      automations_typeThread: () => "当前对话",
      automations_workspacePaths: () => "工作区路径",
      automations_workspacePathsPlaceholder: () => "每行一个绝对路径",
      task_running: () => "执行中",
    },
  }),
}));

import {
  AutomationDeleteDialogContent,
  type AutomationRecord,
  AutomationScheduleValueControl,
  AutomationsPanel,
} from "../AutomationsPanel";

const scheduleControlLL = {
  automations_scheduleDay: () => "星期",
  automations_scheduleEvery: () => "每",
  automations_scheduleTime: () => "时间",
  automations_scheduleUnitDays: () => "天",
  automations_scheduleUnitHours: () => "小时",
  automations_scheduleUnitMinutes: () => "分钟",
  automations_scheduleValue: () => "计划值",
} as unknown as TranslationFunctions;

const installDom = () => {
  const { document, window } = parseHTML(
    '<!doctype html><html><body><div id="root"></div></body></html>',
  );

  Object.assign(window, {
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
  });
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", document);
  vi.stubGlobal("Node", window.Node);
  vi.stubGlobal("HTMLElement", window.HTMLElement);
  vi.stubGlobal("Event", window.Event);
  vi.stubGlobal("MouseEvent", window.MouseEvent);
  vi.stubGlobal("navigator", window.navigator);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

  return { document, window };
};

const automationRecord = (
  overrides: Partial<AutomationRecord> = {},
): AutomationRecord => ({
  id: "auto-1",
  title: "Daily repo check",
  prompt: "Check CI and summarize failures.",
  type: "project",
  scheduleKind: "daily",
  scheduleValue: "09:00",
  enabled: true,
  threadId: null,
  workspacePaths: ["/workspace"],
  runMode: "worktree",
  modelId: null,
  reasoningEffort: null,
  lastRunAt: null,
  nextRunAt: "2026-06-18T09:00:00.000Z",
  createdAt: "2026-06-18T01:00:00.000Z",
  updatedAt: "2026-06-18T01:00:00.000Z",
  ...overrides,
});

const automationRunRecord = () => ({
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
  prompt: "Check CI and summarize failures.",
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
  createdAt: "2026-06-18T01:00:00.000Z",
  updatedAt: "2026-06-18T01:02:00.000Z",
  startedAt: "2026-06-18T01:00:10.000Z",
  completedAt: "2026-06-18T01:02:00.000Z",
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("AutomationsPanel", () => {
  it("renders localized panel chrome while loading", () => {
    const html = renderToStaticMarkup(<AutomationsPanel />);

    expect(html).toContain("自动化");
    expect(html).toContain("管理由 Agent 创建的定时任务、提醒和项目监控。");
    expect(html).toContain("新建自动化");
    expect(html).toContain("正在加载自动化...");
  });

  it("renders automation rows with schedule and run mode metadata", () => {
    const html = renderToStaticMarkup(
      <AutomationsPanel initialAutomations={[automationRecord()]} />,
    );

    expect(html).toContain("Daily repo check");
    expect(html).toContain("项目");
    expect(html).toContain("每天 · 09:00");
    expect(html).not.toContain("daily · 09:00");
    expect(html).toContain("隔离 worktree");
    expect(html).toContain("下次运行");
    expect(html).toContain("手动触发");
    expect(html).not.toContain("正在加载自动化...");
  });

  it("renders the last run time when an automation has run before", () => {
    const automation = automationRecord({
      lastRunAt: "2026-06-18T02:30:00.000Z",
    });

    const fullHtml = renderToStaticMarkup(
      <AutomationsPanel initialAutomations={[automation]} />,
    );
    const railHtml = renderToStaticMarkup(
      <AutomationsPanel variant="rail" initialAutomations={[automation]} />,
    );

    expect(fullHtml).toContain("上次运行");
    expect(railHtml).toContain("上次运行");
  });

  it("renders weekly and interval schedules as localized human-readable text", () => {
    const html = renderToStaticMarkup(
      <AutomationsPanel
        initialAutomations={[
          automationRecord({
            id: "auto-weekly",
            scheduleKind: "weekly",
            scheduleValue: "Mon 09:00",
            title: "Weekly check",
          }),
          automationRecord({
            id: "auto-interval",
            scheduleKind: "interval",
            scheduleValue: "30m",
            title: "CI monitor",
          }),
        ]}
      />,
    );

    expect(html).toContain("每周 · 周一 09:00");
    expect(html).toContain("每 30 分钟");
    expect(html).not.toContain("每周 · Mon 09:00");
    expect(html).not.toContain("间隔 · 30m");
  });

  it("renders a compact rail section without the settings description", () => {
    const html = renderToStaticMarkup(
      <AutomationsPanel
        variant="rail"
        initialAutomations={[automationRecord()]}
      />,
    );

    expect(html).toContain('data-automation-rail="true"');
    expect(html).toContain("自动化");
    expect(html).toContain("Daily repo check");
    expect(html).toContain("每天 · 09:00");
    expect(html).not.toContain("daily · 09:00");
    expect(html).toContain("手动触发");
    expect(html).not.toContain("管理由 Agent 创建的定时任务、提醒和项目监控。");
  });

  it("marks the active automation as running", () => {
    const html = renderToStaticMarkup(
      <AutomationsPanel
        runningAutomationId="auto-1"
        initialAutomations={[automationRecord()]}
      />,
    );

    expect(html).toContain("Daily repo check");
    expect(html).toContain("执行中");
    expect(html).toContain('disabled=""');
  });

  it("marks an automation as running when it has an active run", () => {
    const html = renderToStaticMarkup(
      <AutomationsPanel
        initialAutomations={[automationRecord()]}
        initialRuns={[
          {
            ...automationRunRecord(),
            status: "running",
            errorMessage: null,
            completedAt: null,
          },
        ]}
      />,
    );

    expect(html).toContain("Daily repo check");
    expect(html).toContain("执行中");
    expect(html).toContain('disabled=""');
  });

  it("does not highlight task rows for the active automation chat session", () => {
    const html = renderToStaticMarkup(
      <AutomationsPanel
        activeAutomationId="auto-2"
        initialAutomations={[
          automationRecord({ id: "auto-1", title: "First automation" }),
          automationRecord({ id: "auto-2", title: "Active automation" }),
        ]}
      />,
    );

    expect(html).toContain("Active automation");
    expect(html).not.toContain('data-automation-current="true"');
  });

  it("highlights only the active automation run for the active chat session", () => {
    const html = renderToStaticMarkup(
      <AutomationsPanel
        activeAutomationId="auto-2"
        activeAutomationRunId="run-2"
        initialView="triage"
        initialAutomations={[
          automationRecord({ id: "auto-2", title: "Active automation" }),
        ]}
        initialRuns={[
          {
            ...automationRunRecord(),
            automationId: "auto-2",
            automationTitle: "Older active automation run",
            id: "run-1",
          },
          {
            ...automationRunRecord(),
            automationId: "auto-2",
            automationTitle: "Active automation",
            id: "run-2",
          },
        ]}
      />,
    );
    const { document } = parseHTML(`<div>${html}</div>`);

    const activeRows = Array.from(
      document.querySelectorAll('[data-automation-current="true"]'),
    );
    const activeRow = activeRows[0];

    expect(activeRows).toHaveLength(1);
    expect(activeRow?.getAttribute("data-automation-id")).toBe("auto-2");
    expect(activeRow?.textContent).toContain("Active automation");
    expect(activeRow?.textContent).not.toContain("Older active automation run");
  });

  it("renders recent automation runs for triage without inline details", () => {
    const html = renderToStaticMarkup(
      <AutomationsPanel
        initialView="triage"
        initialAutomations={[automationRecord()]}
        initialRuns={[{ ...automationRunRecord(), totalTokens: 4200 }]}
      />,
    );

    expect(html).toContain("运行诊断");
    expect(html).toContain("失败");
    expect(html).toContain("计划");
    expect(html).toContain("总计 4.2K tokens");
    expect(html).not.toContain("Command failed");
  });

  it("renders triage rows with compact right-aligned actions", () => {
    const html = renderToStaticMarkup(
      <AutomationsPanel
        initialView="triage"
        initialAutomations={[automationRecord()]}
        initialRuns={[
          {
            ...automationRunRecord(),
            status: "running",
            completedAt: null,
            chatSessionId: "session-automation-1",
            assistantMessageId: "assistant-automation-1",
          },
        ]}
      />,
    );

    expect(html).toContain('data-automation-run-layout="compact"');
    expect(html).toContain('data-automation-run-meta="run-1"');
    expect(html).toContain('data-automation-run-actions="run-1"');
    expect(html).toContain("items-start justify-end");
    expect(html).not.toContain("flex-col items-end");
  });

  it("offers an inline detail preview for headless runs without a chat session", () => {
    const html = renderToStaticMarkup(
      <AutomationsPanel
        initialView="triage"
        initialAutomations={[automationRecord()]}
        initialRuns={[automationRunRecord()]}
      />,
    );

    expect(html).toContain("查看详情");
    expect(html).toContain('data-automation-run-detail-mode="preview"');
    expect(html).not.toContain("Command failed");
  });

  it("opens headless scheduled run details in chat when a chat opener is available", () => {
    const html = renderToStaticMarkup(
      <AutomationsPanel
        initialView="triage"
        initialAutomations={[automationRecord()]}
        initialRuns={[automationRunRecord()]}
        onOpenRunDetails={vi.fn()}
      />,
    );

    expect(html).toContain("查看详情");
    expect(html).toContain('data-automation-run-detail-mode="chat"');
    expect(html).not.toContain('data-automation-run-detail-mode="preview"');
  });

  it("renders chat-backed run details as an open-in-chat target", () => {
    const html = renderToStaticMarkup(
      <AutomationsPanel
        initialView="triage"
        initialAutomations={[automationRecord()]}
        initialRuns={[
          {
            ...automationRunRecord(),
            chatSessionId: "session-automation-1",
            assistantMessageId: "assistant-automation-1",
            errorMessage: "Command failed",
          },
        ]}
      />,
    );

    expect(html).toContain(
      'data-automation-run-chat-session-id="session-automation-1"',
    );
    expect(html).toContain("查看详情");
  });

  it("passes the persisted automation metadata when rerunning from triage", async () => {
    const { document, window } = installDom();
    const filework = {
      automations: {
        cancelRun: vi.fn(),
        cleanupRuns: vi.fn(),
        delete: vi.fn(),
        list: vi.fn(() => Promise.resolve([automationRecord()])),
        listRuns: vi.fn(() => Promise.resolve([automationRunRecord()])),
        listRunEvents: vi.fn(() => Promise.resolve([])),
        markRunHandled: vi.fn(),
        continueRun: vi.fn(),
        rerun: vi.fn(),
        trigger: vi.fn(),
        update: vi.fn(),
      },
    };
    Object.assign(window, { filework });
    const onRerunAutomationRun = vi.fn();
    let root: Root | null = createRoot(
      document.getElementById("root") as HTMLElement,
    );

    await act(async () => {
      root?.render(
        <AutomationsPanel
          initialView="triage"
          initialAutomations={[automationRecord()]}
          initialRuns={[automationRunRecord()]}
          onRerunAutomationRun={onRerunAutomationRun}
        />,
      );
    });

    const rerunButton = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("重跑"),
    );
    expect(rerunButton).toBeTruthy();

    await act(async () => {
      rerunButton?.dispatchEvent(new window.Event("click", { bubbles: true }));
    });

    expect(filework.automations.rerun).not.toHaveBeenCalled();
    expect(onRerunAutomationRun).toHaveBeenCalledWith(
      expect.objectContaining({ id: "run-1" }),
      expect.objectContaining({
        id: "auto-1",
        scheduleKind: "daily",
        scheduleValue: "09:00",
        type: "project",
      }),
    );

    await act(async () => {
      root?.unmount();
      root = null;
    });
  });

  it("renders actionable needs-action runs in triage", () => {
    const html = renderToStaticMarkup(
      <AutomationsPanel
        initialView="triage"
        initialAutomations={[automationRecord()]}
        initialRuns={[
          {
            ...automationRunRecord(),
            status: "needs_action",
            needsActionReason: "Requires approval",
            errorMessage: "Requires approval",
            completedAt: null,
          },
        ]}
      />,
    );

    expect(html).toContain("待处理");
    expect(html).toContain("等待处理");
    expect(html).toContain("重跑");
    expect(html).toContain("继续运行");
    expect(html).toContain("标记已处理");
    expect(html).toContain("取消运行");
    expect(html).not.toContain("Requires approval");
  });

  it("renders a cleanup action for handled triage history", () => {
    const html = renderToStaticMarkup(
      <AutomationsPanel
        initialView="triage"
        initialAutomations={[automationRecord()]}
        initialRuns={[
          {
            ...automationRunRecord(),
            status: "succeeded",
            triageStatus: "handled",
            errorMessage: null,
            output: "OK",
          },
        ]}
      />,
    );

    expect(html).toContain("清理已处理");
    expect(html).toContain("清理 30 天前");
    expect(html).toContain("已处理");
  });

  it("keeps automation tasks and triage in separate full-panel views", () => {
    const html = renderToStaticMarkup(
      <AutomationsPanel
        initialAutomations={[automationRecord()]}
        initialRuns={[automationRunRecord()]}
      />,
    );

    expect(html).toContain('data-automation-view="tasks"');
    expect(html).toContain("任务列表");
    expect(html).toContain("运行诊断");
    expect(html).toContain("Daily repo check");
    expect(html).toContain("手动触发");
    expect(html).not.toContain('data-automation-triage-list="true"');
    expect(html).not.toContain('data-automation-run-status="failed"');
    expect(html).not.toContain("Command failed");
  });

  it("places the create action before the task and triage switcher", () => {
    const html = renderToStaticMarkup(
      <AutomationsPanel initialAutomations={[automationRecord()]} />,
    );

    expect(html.indexOf("新建自动化")).toBeLessThan(html.indexOf("任务列表"));
  });

  it("opens the create form with structured schedule controls", async () => {
    const { document, window } = installDom();
    Object.assign(window, {
      filework: {
        automations: {
          previewSchedule: vi.fn(() =>
            Promise.resolve({
              nextRunAt: "2026-06-19T09:00:00.000Z",
              timeZone: "Asia/Shanghai",
            }),
          ),
        },
      },
    });
    let root: Root | null = createRoot(
      document.getElementById("root") as HTMLElement,
    );

    await act(async () => {
      root?.render(<AutomationsPanel initialAutomations={[]} />);
    });

    const createButton = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("新建自动化"),
    );
    expect(createButton).toBeTruthy();

    await act(async () => {
      createButton?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(document.body.innerHTML).toContain(
      'data-automation-draft-open="true"',
    );

    const scheduleHtml = renderToStaticMarkup(
      <AutomationScheduleValueControl
        draft={{
          enabled: true,
          modelId: "",
          prompt: "",
          reasoningEffort: "",
          runMode: "local",
          scheduleKind: "daily",
          scheduleValue: "09:00",
          title: "",
          type: "standalone",
          workspacePathsText: "",
        }}
        LL={scheduleControlLL}
        locale="zh-CN"
        onDraftChange={() => undefined}
      />,
    );

    expect(scheduleHtml).toContain('data-automation-schedule-builder="daily"');
    expect(scheduleHtml).toContain('data-automation-daily-time="true"');
    expect(scheduleHtml).not.toContain('id="automation-schedule-value"');

    const weeklyScheduleHtml = renderToStaticMarkup(
      <AutomationScheduleValueControl
        draft={{
          enabled: true,
          modelId: "",
          prompt: "",
          reasoningEffort: "",
          runMode: "local",
          scheduleKind: "weekly",
          scheduleValue: "Mon 09:00",
          title: "",
          type: "standalone",
          workspacePathsText: "",
        }}
        LL={scheduleControlLL}
        locale="zh-CN"
        onDraftChange={() => undefined}
      />,
    );

    expect(weeklyScheduleHtml).toContain("周一");
    expect(weeklyScheduleHtml).not.toContain("Monday");

    await act(async () => {
      root?.unmount();
      root = null;
    });
  });

  it("prefills the create form from a recommended automation template", async () => {
    const { document, window } = installDom();
    Object.assign(window, {
      filework: {
        automations: {
          previewSchedule: vi.fn(() =>
            Promise.resolve({
              nextRunAt: "2026-06-19T09:00:00.000Z",
              timeZone: "Asia/Shanghai",
            }),
          ),
        },
      },
    });
    let root: Root | null = createRoot(
      document.getElementById("root") as HTMLElement,
    );

    await act(async () => {
      root?.render(<AutomationsPanel initialAutomations={[]} />);
    });

    const templateButton = document.querySelector(
      '[data-automation-template="daily-commit-summary"]',
    );
    expect(templateButton).toBeTruthy();

    await act(async () => {
      (templateButton as HTMLElement | null)?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(document.body.innerHTML).toContain(
      'data-automation-draft-title="每日 commit 统计"',
    );
    expect(document.body.innerHTML).toContain(
      'data-automation-draft-schedule-kind="daily"',
    );

    expect(document.body.innerHTML).toContain("每周 · 周一 09:00");
    expect(document.body.innerHTML).toContain("每 30 分钟");
    expect(document.body.innerHTML).not.toContain("每周 · Mon 09:00");
    expect(document.body.innerHTML).not.toContain("间隔 · 30m");

    await act(async () => {
      root?.unmount();
      root = null;
    });
  });

  it("renders enabled and disabled automations with distinct status treatments", () => {
    const html = renderToStaticMarkup(
      <AutomationsPanel
        initialAutomations={[
          automationRecord({ id: "auto-enabled", title: "Enabled task" }),
          automationRecord({
            id: "auto-disabled",
            title: "Disabled task",
            enabled: false,
          }),
        ]}
      />,
    );

    expect(html).toContain('data-automation-enabled="true"');
    expect(html).toContain('data-automation-enabled="false"');
    expect(html).toContain("已启用");
    expect(html).toContain("已停用");
    expect(html).toContain("opacity-60");
  });

  it("renders a delete confirmation dialog for an automation", () => {
    const html = renderToStaticMarkup(
      <AutomationDeleteDialogContent
        automation={automationRecord()}
        onCancel={() => undefined}
        onConfirm={() => undefined}
      />,
    );

    expect(html).toContain("删除自动化？");
    expect(html).toContain("删除后不会再运行，确定删除这个自动化吗？");
    expect(html).toContain("Daily repo check");
    expect(html).toContain("取消");
    expect(html).toContain("删除");
  });
});
