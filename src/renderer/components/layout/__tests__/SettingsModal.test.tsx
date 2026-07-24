import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../ui/dialog", () => ({
  Dialog: ({ children, open }: { children: ReactNode; open: boolean }) =>
    open ? <div data-dialog="true">{children}</div> : null,
  DialogContent: ({
    children,
    className,
  }: {
    children: ReactNode;
    className?: string;
  }) => (
    <div className={className} data-dialog-content="true">
      {children}
    </div>
  ),
  DialogTitle: ({
    children,
    className,
  }: {
    children: ReactNode;
    className?: string;
  }) => (
    <h2 className={className} data-dialog-title="true">
      {children}
    </h2>
  ),
}));

vi.mock("../../../i18n/i18n-react", () => ({
  useI18nContext: () => ({
    locale: "zh-CN",
    LL: {
      browserSettings_title: () => "浏览器",
      llmConfig_title: () => "LLM 配置",
      memoryDebug_title: () => "记忆调试",
      settings_credentials: () => "凭据",
      settings_groupCapabilities: () => "能力与安全",
      settings_groupDiagnostics: () => "诊断",
      settings_groupPreferences: () => "偏好",
      settings_commandSecurity: () => "命令安全",
      settings_language: () => "语言",
      settings_taskTrace: () => "任务轨迹",
      settings_theme: () => "主题",
      settings_themeDark: () => "深色",
      settings_themeLight: () => "浅色",
      settings_themeSystem: () => "跟随系统",
      settings_title: () => "设置",
      settings_toolWhitelist: () => "可审批工具",
      usage_title: () => "用量统计",
    },
  }),
}));

vi.mock("../../settings/CommandSecurityPanel", () => ({
  CommandSecurityPanel: () => <div data-panel="command-security" />,
}));
vi.mock("../../settings/BrowserSettingsPanel", () => ({
  BrowserSettingsPanel: () => <div data-panel="browser" />,
}));
vi.mock("../../settings/CredentialsPanel", () => ({
  CredentialsPanel: () => <div data-panel="credentials" />,
}));
vi.mock("../../settings/LlmConfigPanel", () => ({
  LlmConfigPanel: () => <div data-panel="llm" />,
}));
vi.mock("../../settings/McpConfigPanel", () => ({
  McpConfigPanel: () => <div data-panel="mcp" />,
}));
vi.mock("../../settings/MemoryDebugPanel", () => ({
  MemoryDebugPanel: () => <div data-panel="memory-debug" />,
}));
vi.mock("../../settings/TaskTracePanel", () => ({
  TaskTracePanel: () => <div data-panel="task-trace" />,
}));
vi.mock("../../settings/ToolWhitelistPanel", () => ({
  ToolWhitelistPanel: () => <div data-panel="tool-whitelist" />,
}));
vi.mock("../../settings/UsagePanel", () => ({
  UsagePanel: () => <div data-panel="usage" />,
}));

import { SettingsModal } from "../SettingsModal";

describe("SettingsModal", () => {
  it("keeps the title area fixed while only the panel content scrolls", () => {
    const html = renderToStaticMarkup(
      <SettingsModal open onClose={vi.fn()} onLocaleChange={vi.fn()} />,
    );

    expect(html).toContain('data-settings-modal-header="true"');
    expect(html).toContain('data-settings-modal-body="true"');
    expect(html).toContain('data-settings-modal-content-scroll="true"');
    expect(html).toContain("shrink-0");
    expect(html).toContain("min-h-0 flex-1 overflow-hidden");
    expect(html).toContain("min-h-0 flex-1 overflow-y-auto");
    expect(html).toContain(">设置<");
  });

  it("opens a requested panel and groups settings by user intent", () => {
    const html = renderToStaticMarkup(
      <SettingsModal
        open
        onClose={vi.fn()}
        onLocaleChange={vi.fn()}
        {...({ initialTab: "llm" } as Record<string, unknown>)}
      />,
    );

    expect(html).toContain('data-settings-active-tab="llm"');
    expect(html).toContain('data-settings-group="preferences"');
    expect(html).toContain('data-settings-group="capabilities"');
    expect(html).toContain('data-settings-group="diagnostics"');
    expect(html).toContain(">偏好<");
    expect(html).toContain(">能力与安全<");
    expect(html).toContain(">诊断<");
    expect(html).toContain(">可审批工具<");
    expect(html).toContain(">命令安全<");
    expect(html).toContain(">任务轨迹<");
  });
});
