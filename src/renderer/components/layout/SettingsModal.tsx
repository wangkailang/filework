import {
  BarChart3,
  Brain,
  ClipboardCheck,
  Cpu,
  Globe,
  KeyRound,
  Monitor,
  Moon,
  Settings,
  Sun,
  X,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useI18nContext } from "../../i18n/i18n-react";
import type { Locales } from "../../i18n/i18n-types";
import { locales } from "../../i18n/i18n-util";
import { loadLocale } from "../../i18n/i18n-util.sync";
import { CredentialsPanel } from "../settings/CredentialsPanel";
import { LlmConfigPanel } from "../settings/LlmConfigPanel";
import { MemoryDebugPanel } from "../settings/MemoryDebugPanel";
import { TaskTracePanel } from "../settings/TaskTracePanel";
import { UsagePanel } from "../settings/UsagePanel";

type Theme = "dark" | "light" | "system";
type Tab =
  | "general"
  | "llm"
  | "credentials"
  | "usage"
  | "memory-debug"
  | "task-trace";

const LOCALE_LABELS: Record<Locales, string> = {
  en: "English",
  ja: "日本語",
  "zh-CN": "简体中文",
};

const THEME_ICONS: Record<Theme, typeof Moon> = {
  dark: Moon,
  light: Sun,
  system: Monitor,
};

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  onLocaleChange: (locale: Locales) => void;
}

const applyTheme = (t: Theme) => {
  const root = document.documentElement;
  if (t === "system") {
    const prefersDark = window.matchMedia(
      "(prefers-color-scheme: dark)",
    ).matches;
    root.classList.toggle("dark", prefersDark);
    root.classList.toggle("light", !prefersDark);
  } else {
    root.classList.toggle("dark", t === "dark");
    root.classList.toggle("light", t === "light");
  }
};

export const SettingsModal = ({
  open,
  onClose,
  onLocaleChange,
}: SettingsModalProps) => {
  const { LL, locale } = useI18nContext();
  const [theme, setTheme] = useState<Theme>("dark");
  const [activeTab, setActiveTab] = useState<Tab>("general");
  const [hardGate, setHardGate] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem("filework-theme") as Theme | null;
    if (saved) {
      setTheme(saved);
      applyTheme(saved);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    window.filework
      .getSetting("processDiscipline.hardGate")
      .then((value) => {
        if (!cancelled) setHardGate(value === "true");
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open]);

  const toggleHardGate = useCallback(() => {
    const next = !hardGate;
    setHardGate(next);
    window.filework
      .setSetting("processDiscipline.hardGate", next ? "true" : "false")
      .catch((err) => {
        console.warn("[settings] hardGate write failed", err);
      });
  }, [hardGate]);

  const handleThemeChange = (t: Theme) => {
    setTheme(t);
    localStorage.setItem("filework-theme", t);
    applyTheme(t);
  };

  const handleLocaleChange = useCallback(
    (newLocale: Locales) => {
      loadLocale(newLocale);
      onLocaleChange(newLocale);
      localStorage.setItem("filework-locale", newLocale);
    },
    [onLocaleChange],
  );

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    if (open) window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) return null;

  const themeKeys: Theme[] = ["dark", "light", "system"];
  const themeLabels: Record<Theme, string> = {
    dark: LL.settings_themeDark(),
    light: LL.settings_themeLight(),
    system: LL.settings_themeSystem(),
  };

  const tabs: { id: Tab; label: string; icon: typeof Settings }[] = [
    { id: "general", label: LL.settings_title(), icon: Settings },
    { id: "llm", label: LL.llmConfig_title(), icon: Cpu },
    { id: "credentials", label: "Credentials", icon: KeyRound },
    { id: "usage", label: LL.usage_title(), icon: BarChart3 },
    { id: "memory-debug", label: LL.memoryDebug_title(), icon: Brain },
    { id: "task-trace", label: "Task Trace", icon: Monitor },
  ];

  return (
    <div className="fixed inset-0 z-100 flex items-center justify-center">
      <button
        type="button"
        className="absolute inset-0 bg-black/50 cursor-default"
        onClick={onClose}
        aria-label="Close settings"
      />

      <div className="relative flex bg-background border border-border rounded-xl shadow-2xl overflow-hidden w-[calc(100vw-64px)] h-[calc(100vh-48px)] max-w-[1200px] max-h-[900px]">
        {/* Left sidebar tabs */}
        <div className="flex flex-col w-44 shrink-0 border-r border-border bg-muted/50 py-3">
          <div className="flex items-center justify-between px-4 pb-3 border-b border-border mb-2">
            <h2 className="text-sm font-medium text-foreground">
              {LL.settings_title()}
            </h2>
            <button
              type="button"
              onClick={onClose}
              className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
          {tabs.map((tab) => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-2 mx-2 px-3 py-2 text-sm rounded-lg transition-colors ${
                  activeTab === tab.id
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                }`}
              >
                <Icon className="w-4 h-4" />
                {tab.label}
              </button>
            );
          })}
        </div>

        {/* Right content */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {activeTab === "general" && (
            <div className="space-y-6">
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

              {/* Process Discipline (brainstorming HARD-GATE) */}
              <div className="space-y-2">
                <span className="flex items-center gap-2 text-sm font-medium text-foreground">
                  <ClipboardCheck className="w-4 h-4 text-muted-foreground" />
                  {LL.settings_processDiscipline()}
                </span>
                <button
                  type="button"
                  onClick={toggleHardGate}
                  className={`w-full flex items-start justify-between gap-3 px-3 py-2.5 rounded-lg border text-left transition-colors ${
                    hardGate
                      ? "border-primary/50 bg-primary/5"
                      : "border-border hover:bg-accent"
                  }`}
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-foreground">
                      {LL.settings_processDiscipline_hardGate()}
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground leading-relaxed">
                      {LL.settings_processDiscipline_hardGate_hint()}
                    </div>
                  </div>
                  <span
                    className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
                      hardGate ? "bg-primary" : "bg-muted"
                    }`}
                    aria-hidden
                  >
                    <span
                      className={`inline-block h-4 w-4 transform rounded-full bg-background transition-transform ${
                        hardGate ? "translate-x-4" : "translate-x-0.5"
                      }`}
                    />
                  </span>
                </button>
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

          {activeTab === "credentials" && <CredentialsPanel />}

          {activeTab === "usage" && <UsagePanel />}

          {activeTab === "memory-debug" && <MemoryDebugPanel />}

          {activeTab === "task-trace" && <TaskTracePanel />}
        </div>
      </div>
    </div>
  );
};
