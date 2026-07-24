import {
  BarChart3,
  Brain,
  Compass,
  Cpu,
  Globe,
  KeyRound,
  Lock,
  Monitor,
  Moon,
  Plug,
  Settings,
  Shield,
  Sun,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useI18nContext } from "../../i18n/i18n-react";
import type { Locales } from "../../i18n/i18n-types";
import { locales } from "../../i18n/i18n-util";
import { loadLocale } from "../../i18n/i18n-util.sync";
import {
  getStoredThemePreference,
  setStoredThemePreference,
  type ThemePreference,
} from "../../lib/theme";
import { BrowserSettingsPanel } from "../settings/BrowserSettingsPanel";
import { CommandSecurityPanel } from "../settings/CommandSecurityPanel";
import { CredentialsPanel } from "../settings/CredentialsPanel";
import { LlmConfigPanel } from "../settings/LlmConfigPanel";
import { McpConfigPanel } from "../settings/McpConfigPanel";
import { MemoryDebugPanel } from "../settings/MemoryDebugPanel";
import { TaskTracePanel } from "../settings/TaskTracePanel";
import { ToolWhitelistPanel } from "../settings/ToolWhitelistPanel";
import { UsagePanel } from "../settings/UsagePanel";
import { Dialog, DialogContent, DialogTitle } from "../ui/dialog";

export type SettingsTab =
  | "general"
  | "browser"
  | "llm"
  | "credentials"
  | "mcp"
  | "tool-whitelist"
  | "usage"
  | "memory-debug"
  | "task-trace"
  | "command-security";

const SETTINGS_TABS: SettingsTab[] = [
  "general",
  "browser",
  "llm",
  "credentials",
  "mcp",
  "tool-whitelist",
  "usage",
  "memory-debug",
  "task-trace",
  "command-security",
];

export const isSettingsTab = (value: unknown): value is SettingsTab =>
  typeof value === "string" && SETTINGS_TABS.includes(value as SettingsTab);

const LOCALE_LABELS: Record<Locales, string> = {
  en: "English",
  ja: "日本語",
  "zh-CN": "简体中文",
};

const THEME_ICONS: Record<ThemePreference, typeof Moon> = {
  dark: Moon,
  light: Sun,
  system: Monitor,
};

interface SettingsModalProps {
  initialTab?: SettingsTab;
  open: boolean;
  onClose: () => void;
  onLocaleChange: (locale: Locales) => void;
}

export const SettingsModal = ({
  initialTab = "general",
  open,
  onClose,
  onLocaleChange,
}: SettingsModalProps) => {
  const { LL, locale } = useI18nContext();
  const [theme, setTheme] = useState<ThemePreference>("dark");
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab);

  useEffect(() => {
    setTheme(getStoredThemePreference());
  }, []);

  useEffect(() => {
    if (open) setActiveTab(initialTab);
  }, [initialTab, open]);

  const handleThemeChange = (t: ThemePreference) => {
    setTheme(t);
    setStoredThemePreference(t);
  };

  const handleLocaleChange = useCallback(
    (newLocale: Locales) => {
      loadLocale(newLocale);
      onLocaleChange(newLocale);
      localStorage.setItem("filework-locale", newLocale);
    },
    [onLocaleChange],
  );

  const themeKeys: ThemePreference[] = ["dark", "light", "system"];
  const themeLabels: Record<ThemePreference, string> = {
    dark: LL.settings_themeDark(),
    light: LL.settings_themeLight(),
    system: LL.settings_themeSystem(),
  };

  const tabGroups: Array<{
    id: "preferences" | "capabilities" | "diagnostics";
    label: string;
    tabs: Array<{ id: SettingsTab; label: string; icon: typeof Settings }>;
  }> = [
    {
      id: "preferences",
      label: LL.settings_groupPreferences(),
      tabs: [
        { id: "general", label: LL.settings_title(), icon: Settings },
        { id: "browser", label: LL.browserSettings_title(), icon: Compass },
      ],
    },
    {
      id: "capabilities",
      label: LL.settings_groupCapabilities(),
      tabs: [
        { id: "llm", label: LL.llmConfig_title(), icon: Cpu },
        { id: "credentials", label: LL.settings_credentials(), icon: KeyRound },
        { id: "mcp", label: "MCP", icon: Plug },
        {
          id: "tool-whitelist",
          label: LL.settings_toolWhitelist(),
          icon: Shield,
        },
        {
          id: "command-security",
          label: LL.settings_commandSecurity(),
          icon: Lock,
        },
      ],
    },
    {
      id: "diagnostics",
      label: LL.settings_groupDiagnostics(),
      tabs: [
        { id: "usage", label: LL.usage_title(), icon: BarChart3 },
        { id: "memory-debug", label: LL.memoryDebug_title(), icon: Brain },
        {
          id: "task-trace",
          label: LL.settings_taskTrace(),
          icon: Monitor,
        },
      ],
    },
  ];

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
    >
      <DialogContent
        data-settings-active-tab={activeTab}
        className="flex! h-[calc(100vh-32px)]! max-h-[820px]! w-[calc(100vw-32px)]! max-w-[1000px]! flex-col gap-0! overflow-hidden bg-background! p-0! text-foreground! shadow-2xl"
      >
        <div
          data-settings-modal-header="true"
          className="flex shrink-0 items-center border-b border-border px-5 py-3 pr-12"
        >
          <DialogTitle className="text-sm font-medium text-foreground">
            {LL.settings_title()}
          </DialogTitle>
        </div>

        <div
          data-settings-active-tab={activeTab}
          data-settings-modal-body="true"
          className="flex min-h-0 flex-1 overflow-hidden"
        >
          {/* Left sidebar tabs */}
          <div className="flex w-48 shrink-0 flex-col gap-4 overflow-y-auto border-r border-border bg-muted/50 py-3 max-[900px]:w-44">
            {tabGroups.map((group) => (
              <div key={group.id} data-settings-group={group.id}>
                <div className="mb-1 px-5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/80">
                  {group.label}
                </div>
                {group.tabs.map((tab) => {
                  const Icon = tab.icon;
                  return (
                    <button
                      key={tab.id}
                      type="button"
                      aria-current={activeTab === tab.id ? "page" : undefined}
                      onClick={() => setActiveTab(tab.id)}
                      className={`mx-2 flex min-h-9 w-[calc(100%-16px)] items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                        activeTab === tab.id
                          ? "bg-accent text-foreground"
                          : "text-muted-foreground hover:bg-accent/50 hover:text-foreground active:bg-accent"
                      }`}
                    >
                      <Icon className="size-4 shrink-0" />
                      <span className="truncate">{tab.label}</span>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>

          {/* Right content */}
          <div
            data-settings-modal-content-scroll="true"
            className="min-h-0 flex-1 overflow-y-auto px-8 py-6 max-[900px]:px-5"
          >
            {activeTab === "general" && (
              <div className="max-w-3xl space-y-6">
                {/* Language */}
                <div className="space-y-2">
                  <span className="flex items-center gap-2 text-sm font-medium text-foreground">
                    <Globe className="w-4 h-4 text-muted-foreground" />
                    {LL.settings_language()}
                  </span>
                  <div className="grid grid-cols-3 gap-2">
                    {locales.map((loc) => (
                      <button
                        key={loc}
                        type="button"
                        onClick={() => handleLocaleChange(loc)}
                        className={`px-3 py-2 text-sm rounded-lg border transition-colors ${
                          locale === loc
                            ? "border-primary bg-primary/10 text-primary"
                            : "border-border text-muted-foreground hover:bg-accent hover:text-foreground"
                        }`}
                      >
                        {LOCALE_LABELS[loc]}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Theme */}
                <div className="space-y-2">
                  <span className="flex items-center gap-2 text-sm font-medium text-foreground">
                    <Moon className="w-4 h-4 text-muted-foreground" />
                    {LL.settings_theme()}
                  </span>
                  <div className="grid grid-cols-3 gap-2">
                    {themeKeys.map((t) => {
                      const Icon = THEME_ICONS[t];
                      return (
                        <button
                          key={t}
                          type="button"
                          onClick={() => handleThemeChange(t)}
                          className={`flex items-center justify-center gap-2 px-3 py-2 text-sm rounded-lg border transition-colors ${
                            theme === t
                              ? "border-primary bg-primary/10 text-primary"
                              : "border-border text-muted-foreground hover:bg-accent hover:text-foreground"
                          }`}
                        >
                          <Icon className="w-3.5 h-3.5" />
                          {themeLabels[t]}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}

            {activeTab === "llm" && <LlmConfigPanel />}

            {activeTab === "browser" && <BrowserSettingsPanel />}

            {activeTab === "credentials" && <CredentialsPanel />}

            {activeTab === "mcp" && <McpConfigPanel />}

            {activeTab === "tool-whitelist" && <ToolWhitelistPanel />}

            {activeTab === "usage" && <UsagePanel />}

            {activeTab === "memory-debug" && <MemoryDebugPanel />}

            {activeTab === "task-trace" && <TaskTracePanel />}

            {activeTab === "command-security" && <CommandSecurityPanel />}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};
