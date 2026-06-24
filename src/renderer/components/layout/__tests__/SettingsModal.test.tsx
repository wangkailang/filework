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
      llmConfig_title: () => "LLM 配置",
      memoryDebug_title: () => "记忆调试",
      settings_credentials: () => "凭据",
      settings_language: () => "语言",
      settings_theme: () => "主题",
      settings_themeDark: () => "深色",
      settings_themeLight: () => "浅色",
      settings_themeSystem: () => "跟随系统",
      settings_title: () => "设置",
      usage_title: () => "用量统计",
    },
  }),
}));

vi.mock("../../settings/CommandSecurityPanel", () => ({
  CommandSecurityPanel: () => <div data-panel="command-security" />,
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
});
