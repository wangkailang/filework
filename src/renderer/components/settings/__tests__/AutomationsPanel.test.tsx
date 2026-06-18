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
      automations_save: () => "保存",
      automations_schedule: () => "计划",
      automations_statusDisabled: () => "已停用",
      automations_statusEnabled: () => "已启用",
      automations_trigger: () => "手动触发",
      automations_triggering: () => "触发中",
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
    expect(html).toContain("daily · 09:00");
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
