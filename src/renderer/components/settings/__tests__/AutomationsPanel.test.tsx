import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../i18n/i18n-react", () => ({
  useI18nContext: () => ({
    locale: "zh-CN",
    LL: {
      automations_add: () => "新建自动化",
      automations_cancel: () => "取消",
      automations_description: () =>
        "管理由 Agent 创建的定时任务、提醒和项目监控。",
      automations_delete: () => "删除",
      automations_deleteConfirmDesc: () =>
        "删除后不会再运行，确定删除这个自动化吗？",
      automations_deleteConfirmTitle: () => "删除自动化？",
      automations_disable: () => "停用",
      automations_edit: () => "编辑",
      automations_empty: () => "还没有自动化。",
      automations_enable: () => "启用",
      automations_enabled: () => "启用",
      automations_loading: () => "正在加载自动化...",
      automations_lastRun: ({ value }: { value: string }) =>
        `上次运行 ${value}`,
      automations_nextRun: ({ value }: { value: string }) =>
        `下次运行 ${value}`,
      automations_notScheduled: () => "未计划",
      automations_prompt: () => "Prompt",
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
      automations_runStatusQueued: () => "排队中",
      automations_runStatusRunning: () => "运行中",
      automations_runStatusSucceeded: () => "成功",
      automations_runDetailTitle: () => "运行详情",
      automations_runDetailPrompt: () => "Prompt",
      automations_runDetailOutput: () => "输出",
      automations_runDetailError: () => "错误",
      automations_runDetailWorkspace: () => "工作区",
      automations_runDetailTokens: () => "Token 用量",
      automations_showTasks: () => "任务列表",
      automations_showTriage: () => "运行诊断",
      automations_scheduleCron: () => "Cron",
      automations_scheduleDaily: () => "每天",
      automations_scheduleInterval: () => "间隔",
      automations_scheduleWeekly: () => "每周",
      automations_tokenInput: ({ value }: { value: string }) =>
        `输入 ${value} tokens`,
      automations_tokenOutput: ({ value }: { value: string }) =>
        `输出 ${value} tokens`,
      automations_tokenTotal: ({ value }: { value: string }) =>
        `总计 ${value} tokens`,
      automations_viewDetails: () => "查看详情",
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
      automations_typeProject: () => "项目",
      automations_typeStandalone: () => "独立",
      automations_typeThread: () => "当前对话",
      task_running: () => "执行中",
    },
  }),
}));

import {
  AutomationDeleteDialogContent,
  type AutomationRecord,
  AutomationRunDetailDialogContent,
  AutomationsPanel,
} from "../AutomationsPanel";

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
  prompt: "Check CI and summarize failures.",
  workspacePaths: ["/workspace"],
  threadId: null,
  modelId: null,
  output: null,
  errorMessage: "Command failed",
  inputTokens: null,
  outputTokens: null,
  totalTokens: null,
  createdAt: "2026-06-18T01:00:00.000Z",
  updatedAt: "2026-06-18T01:02:00.000Z",
  startedAt: "2026-06-18T01:00:10.000Z",
  completedAt: "2026-06-18T01:02:00.000Z",
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

  it("renders recent automation runs for triage", () => {
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
    expect(html).toContain("Command failed");
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

  it("renders run detail content for triage drill-in", () => {
    const output = "## Changed files\n\n- **Changed files summary**";
    const html = renderToStaticMarkup(
      <AutomationRunDetailDialogContent
        run={{
          ...automationRunRecord(),
          output,
          inputTokens: 1200,
          outputTokens: 3400,
          totalTokens: 4600,
        }}
      />,
    );

    expect(html).toContain("运行详情");
    expect(html).toContain("Daily repo check");
    expect(html).toContain("失败");
    expect(html).toContain("错误");
    expect(html).toContain("Command failed");
    expect(html).toContain("输出");
    expect(html).toContain("Changed files summary");
    expect(html).toContain('data-automation-run-detail-layout="expanded"');
    expect(html).toContain('data-automation-run-output-markdown="true"');
    expect(html).not.toContain("**Changed files summary**");
    expect(html).toContain("工作区");
    expect(html).toContain("/workspace");
    expect(html).toContain("Token 用量");
    expect(html).toContain("输入 1.2K tokens");
    expect(html).toContain("输出 3.4K tokens");
    expect(html).toContain("总计 4.6K tokens");
    expect(html).not.toContain("in 1,200");
    expect(html).not.toContain("out 3,400");
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
