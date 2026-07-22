import {
  CheckCircle2,
  Download,
  FolderOpen,
  Globe2,
  Loader2,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import type {
  BrowserSettings,
  BrowserSettingsPatch,
} from "../../../shared/browser";
import { useI18nContext } from "../../i18n/i18n-react";
import { ConfirmDialog } from "../ui/confirm-dialog";

type OriginKind = "allowed" | "blocked";

interface SettingSwitchProps {
  checked: boolean;
  disabled?: boolean;
  label: string;
  testId: string;
  onChange: (next: boolean) => void;
}

const SettingSwitch = ({
  checked,
  disabled = false,
  label,
  testId,
  onChange,
}: SettingSwitchProps) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    aria-label={label}
    data-browser-developer-mode={
      testId === "developer-mode" ? "true" : undefined
    }
    data-browser-download-ask={testId === "download-ask" ? "true" : undefined}
    disabled={disabled}
    onClick={() => onChange(!checked)}
    className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors disabled:opacity-50 ${
      checked ? "border-primary bg-primary" : "border-border bg-muted"
    }`}
  >
    <span
      className={`size-4 rounded-full bg-background shadow-sm transition-transform ${
        checked ? "translate-x-4" : "translate-x-0.5"
      }`}
    />
  </button>
);

export function BrowserSettingsPanel() {
  const { LL } = useI18nContext();
  const [settings, setSettings] = useState<BrowserSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [clearOpen, setClearOpen] = useState(false);
  const [cleared, setCleared] = useState(false);

  useEffect(() => {
    let mounted = true;
    window.filework.browserSettings
      .get()
      .then((value) => {
        if (mounted) setSettings(value);
      })
      .catch((cause) => {
        if (mounted) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, []);

  const update = useCallback(async (patch: BrowserSettingsPatch) => {
    setBusy("settings");
    setError(null);
    try {
      const next = await window.filework.browserSettings.set(patch);
      setSettings(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }, []);

  const revokeOrigin = (kind: OriginKind, origin: string) => {
    if (!settings) return;
    const key = kind === "allowed" ? "allowedOrigins" : "blockedOrigins";
    void update({ [key]: settings[key].filter((value) => value !== origin) });
  };

  const chooseDownloadDirectory = async () => {
    if (!settings) return;
    setBusy("directory");
    setError(null);
    try {
      const selected = await window.filework.openDirectory(
        settings.downloadDirectory || undefined,
      );
      if (!selected) return;
      const next = await window.filework.browserSettings.set({
        downloadAskEveryTime: false,
        downloadDirectory: selected,
      });
      setSettings(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const clearBrowserData = async () => {
    setBusy("clear");
    setError(null);
    setCleared(false);
    try {
      await window.filework.browser.clearData();
      setClearOpen(false);
      setCleared(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        {LL.browserSettings_loading()}
      </div>
    );
  }

  if (!settings) {
    return (
      <p className="py-8 text-sm text-destructive">
        {LL.browserSettings_error({ reason: error ?? "Unknown error" })}
      </p>
    );
  }

  const originGroups: Array<{
    kind: OriginKind;
    label: string;
    origins: string[];
  }> = [
    {
      kind: "allowed",
      label: LL.browserSettings_allowed(),
      origins: settings.allowedOrigins,
    },
    {
      kind: "blocked",
      label: LL.browserSettings_blocked(),
      origins: settings.blockedOrigins,
    },
  ];

  return (
    <div className="mx-auto max-w-3xl space-y-6 pb-8">
      <div>
        <h3 className="text-sm font-semibold tracking-tight text-foreground">
          {LL.browserSettings_title()}
        </h3>
        <p className="mt-1 max-w-2xl text-xs leading-5 text-muted-foreground">
          {LL.browserSettings_description()}
        </p>
      </div>

      <section className="overflow-hidden rounded-xl border border-border bg-background shadow-sm">
        <div className="flex items-start gap-3 border-b border-border bg-muted/25 px-4 py-3.5">
          <div className="grid size-8 shrink-0 place-items-center rounded-lg border border-border bg-background text-sky-500">
            <Globe2 className="size-4" />
          </div>
          <div>
            <h4 className="text-sm font-medium text-foreground">
              {LL.browserSettings_origins()}
            </h4>
            <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
              {LL.browserSettings_originsHint()}
            </p>
          </div>
        </div>
        <div className="grid gap-px bg-border md:grid-cols-2">
          {originGroups.map(({ kind, label, origins }) => (
            <div key={kind} className="min-w-0 bg-background p-4">
              <div className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                <span
                  className={`size-1.5 rounded-full ${
                    kind === "allowed" ? "bg-emerald-500" : "bg-destructive"
                  }`}
                />
                {label}
              </div>
              {origins.length === 0 ? (
                <p className="py-2 text-xs text-muted-foreground/70">
                  {LL.browserSettings_emptyOrigins()}
                </p>
              ) : (
                <ul className="space-y-1.5">
                  {origins.map((origin) => (
                    <li
                      key={origin}
                      data-browser-origin={kind}
                      className="flex items-center gap-2 rounded-md border border-border/70 bg-muted/20 px-2.5 py-2"
                    >
                      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground/80">
                        {origin}
                      </span>
                      <button
                        type="button"
                        aria-label={LL.browserSettings_revokeOrigin({ origin })}
                        title={LL.browserSettings_revokeOrigin({ origin })}
                        disabled={busy !== null}
                        onClick={() => revokeOrigin(kind, origin)}
                        className="grid size-6 shrink-0 place-items-center rounded text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-40"
                      >
                        <X className="size-3.5" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-xl border border-border bg-background p-4 shadow-sm">
        <div className="flex items-start gap-3">
          <div className="grid size-8 shrink-0 place-items-center rounded-lg border border-border bg-muted/30 text-foreground/70">
            <Download className="size-4" />
          </div>
          <div className="min-w-0 flex-1">
            <h4 className="text-sm font-medium text-foreground">
              {LL.browserSettings_downloads()}
            </h4>
            <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
              {LL.browserSettings_downloadsHint()}
            </p>
          </div>
        </div>

        <div className="mt-4 divide-y divide-border rounded-lg border border-border">
          <div className="flex items-center justify-between gap-4 px-3 py-3">
            <div>
              <div className="text-sm text-foreground">
                {LL.browserSettings_askEveryTime()}
              </div>
              <div className="mt-0.5 text-xs text-muted-foreground">
                {LL.browserSettings_askEveryTimeHint()}
              </div>
            </div>
            <SettingSwitch
              checked={settings.downloadAskEveryTime}
              disabled={busy !== null}
              label={LL.browserSettings_askEveryTime()}
              testId="download-ask"
              onChange={(next) => void update({ downloadAskEveryTime: next })}
            />
          </div>
          <div className="flex items-center justify-between gap-4 px-3 py-3">
            <div className="min-w-0">
              <div className="text-sm text-foreground">
                {LL.browserSettings_downloadDirectory()}
              </div>
              <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
                {settings.downloadDirectory ||
                  LL.browserSettings_defaultDirectory()}
              </div>
            </div>
            <button
              type="button"
              data-browser-download-directory="true"
              disabled={busy !== null}
              onClick={() => void chooseDownloadDirectory()}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-muted/25 px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent disabled:opacity-40"
            >
              {busy === "directory" ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <FolderOpen className="size-3.5" />
              )}
              {LL.browserSettings_chooseDirectory()}
            </button>
          </div>
        </div>
      </section>

      <section className="rounded-xl border border-border bg-background p-4 shadow-sm">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="grid size-8 shrink-0 place-items-center rounded-lg border border-border bg-muted/30 text-foreground/70">
              <ShieldCheck className="size-4" />
            </div>
            <div>
              <h4 className="text-sm font-medium text-foreground">
                {LL.browserSettings_developerMode()}
              </h4>
              <p className="mt-0.5 max-w-xl text-xs leading-5 text-muted-foreground">
                {LL.browserSettings_developerModeHint()}
              </p>
            </div>
          </div>
          <SettingSwitch
            checked={settings.developerModeEnabled}
            disabled={busy !== null}
            label={LL.browserSettings_developerMode()}
            testId="developer-mode"
            onChange={(next) => void update({ developerModeEnabled: next })}
          />
        </div>
      </section>

      <section className="rounded-xl border border-destructive/25 bg-destructive/[0.025] p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h4 className="text-sm font-medium text-foreground">
              {LL.browserSettings_data()}
            </h4>
            <p className="mt-1 max-w-xl text-xs leading-5 text-muted-foreground">
              {LL.browserSettings_dataHint()}
            </p>
          </div>
          <button
            type="button"
            data-browser-clear-data="true"
            disabled={busy !== null}
            onClick={() => setClearOpen(true)}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-destructive/30 px-2.5 py-1.5 text-xs font-medium text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-40"
          >
            <Trash2 className="size-3.5" />
            {LL.browserSettings_clearAction()}
          </button>
        </div>
        {cleared && (
          <p className="mt-3 flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400">
            <CheckCircle2 className="size-3.5" />
            {LL.browserSettings_cleared()}
          </p>
        )}
      </section>

      {error && (
        <p className="rounded-lg border border-destructive/25 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {LL.browserSettings_error({ reason: error })}
        </p>
      )}

      <ConfirmDialog
        open={clearOpen}
        title={LL.browserSettings_clearTitle()}
        description={LL.browserSettings_clearDescription()}
        confirmLabel={LL.browserSettings_clearConfirm()}
        cancelLabel={LL.browserSettings_cancel()}
        destructive
        busy={busy === "clear"}
        onOpenChange={setClearOpen}
        onConfirm={clearBrowserData}
      />
    </div>
  );
}
