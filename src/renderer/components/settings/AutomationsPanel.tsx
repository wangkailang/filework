import {
  AlertTriangle,
  CalendarClock,
  FileText,
  Loader2,
  Pencil,
  Play,
  Plus,
  Power,
  Trash2,
} from "lucide-react";
import {
  type ElementType,
  type FormEvent,
  useCallback,
  useEffect,
  useState,
} from "react";

import { useI18nContext } from "../../i18n/i18n-react";
import type { Locales, TranslationFunctions } from "../../i18n/i18n-types";
import { formatTokens } from "../../utils/format";
import { MessageResponse } from "../ai-elements/message";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "../ui/dialog";

type AutomationType = "thread" | "standalone" | "project";
type AutomationScheduleKind = "interval" | "daily" | "weekly" | "cron";
type AutomationRunMode = "local" | "worktree";
type AutomationView = "tasks" | "triage";

export interface AutomationRecord {
  id: string;
  title: string;
  prompt: string;
  type: AutomationType;
  scheduleKind: AutomationScheduleKind;
  scheduleValue: string;
  enabled: boolean;
  threadId: string | null;
  workspacePaths: string[] | null;
  runMode: AutomationRunMode | null;
  modelId: string | null;
  reasoningEffort: string | null;
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AutomationRunRecord {
  id: string;
  automationId: string;
  automationTitle: string;
  trigger: "manual" | "scheduled";
  status: "queued" | "running" | "succeeded" | "failed" | "canceled";
  prompt: string;
  workspacePaths: string[] | null;
  threadId: string | null;
  modelId: string | null;
  output: string | null;
  errorMessage: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

interface AutomationDraft {
  id?: string;
  title: string;
  prompt: string;
  type: AutomationType;
  scheduleKind: AutomationScheduleKind;
  scheduleValue: string;
  enabled: boolean;
  workspacePathsText: string;
  runMode: AutomationRunMode;
  modelId: string;
  reasoningEffort: string;
}

interface AutomationsPanelProps {
  initialAutomations?: AutomationRecord[];
  initialRuns?: AutomationRunRecord[];
  initialView?: AutomationView;
  onTriggerAutomation?: (automation: AutomationRecord) => Promise<void> | void;
  onAfterTriggerAutomation?: () => void;
  runningAutomationId?: string | null;
  variant?: "full" | "rail";
}

const EMPTY_DRAFT: AutomationDraft = {
  title: "",
  prompt: "",
  type: "standalone",
  scheduleKind: "daily",
  scheduleValue: "09:00",
  enabled: true,
  workspacePathsText: "",
  runMode: "local",
  modelId: "",
  reasoningEffort: "",
};

const inputCls =
  "w-full rounded-lg border border-border bg-background px-2.5 py-2 text-sm text-foreground focus:border-primary focus:outline-none";

const typeLabels = (
  LL: TranslationFunctions,
): Record<AutomationType, string> => ({
  project: LL.automations_typeProject(),
  standalone: LL.automations_typeStandalone(),
  thread: LL.automations_typeThread(),
});

const scheduleKindLabels = (
  LL: TranslationFunctions,
): Record<AutomationScheduleKind, string> => ({
  cron: LL.automations_scheduleCron(),
  daily: LL.automations_scheduleDaily(),
  interval: LL.automations_scheduleInterval(),
  weekly: LL.automations_scheduleWeekly(),
});

const runModeLabels = (
  LL: TranslationFunctions,
): Record<AutomationRunMode, string> => ({
  local: LL.automations_runModeLocal(),
  worktree: LL.automations_runModeWorktree(),
});

const formatDateTime = (iso: string | null, locale: Locales): string | null => {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  try {
    return new Intl.DateTimeFormat(locale, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(date);
  } catch {
    return date.toLocaleString();
  }
};

const parseWorkspacePaths = (value: string): string[] | null => {
  const paths = value
    .split(/\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
  return paths.length ? paths : null;
};

const draftFromAutomation = (
  automation: AutomationRecord,
): AutomationDraft => ({
  id: automation.id,
  title: automation.title,
  prompt: automation.prompt,
  type: automation.type,
  scheduleKind: automation.scheduleKind,
  scheduleValue: automation.scheduleValue,
  enabled: automation.enabled,
  workspacePathsText: automation.workspacePaths?.join("\n") ?? "",
  runMode: automation.runMode ?? "local",
  modelId: automation.modelId ?? "",
  reasoningEffort: automation.reasoningEffort ?? "",
});

const automationStatus = (
  automation: AutomationRecord,
  LL: TranslationFunctions,
) =>
  automation.enabled
    ? {
        label: LL.automations_statusEnabled(),
        rowClass: "border-emerald-500/20 bg-emerald-500/5",
        iconClass:
          "bg-emerald-500/10 text-emerald-700 ring-1 ring-emerald-500/20 dark:text-emerald-300",
        dotClass: "bg-emerald-500 shadow-[0_0_0_3px_rgba(16,185,129,0.14)]",
        pillClass:
          "border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
        titleClass: "text-foreground",
        bodyClass: "text-muted-foreground",
        toggleClass:
          "text-emerald-700 hover:bg-emerald-500/10 hover:text-emerald-800 dark:text-emerald-300",
      }
    : {
        label: LL.automations_statusDisabled(),
        rowClass: "border-border bg-muted/30 opacity-60",
        iconClass: "bg-muted text-muted-foreground",
        dotClass: "bg-muted-foreground/40",
        pillClass: "border-border bg-muted text-muted-foreground",
        titleClass: "text-muted-foreground",
        bodyClass: "text-muted-foreground/70",
        toggleClass: "text-primary hover:bg-primary/10 hover:text-primary",
      };

const automationRunStatusLabels = (
  LL: TranslationFunctions,
): Record<AutomationRunRecord["status"], string> => ({
  canceled: LL.automations_runStatusCanceled(),
  failed: LL.automations_runStatusFailed(),
  queued: LL.automations_runStatusQueued(),
  running: LL.automations_runStatusRunning(),
  succeeded: LL.automations_runStatusSucceeded(),
});

const automationRunStatusClass = (
  status: AutomationRunRecord["status"],
): string => {
  if (status === "succeeded") {
    return "border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  }
  if (status === "failed") {
    return "border-destructive/20 bg-destructive/10 text-destructive";
  }
  if (status === "running" || status === "queued") {
    return "border-sky-500/20 bg-sky-500/10 text-sky-700 dark:text-sky-300";
  }
  return "border-border bg-muted text-muted-foreground";
};

const isActiveAutomationRun = (run: AutomationRunRecord): boolean =>
  run.status === "queued" || run.status === "running";

interface AutomationFormDialogProps {
  draft: AutomationDraft;
  saving: boolean;
  onDraftChange: (draft: AutomationDraft) => void;
  onClose: () => void;
  onSubmit: () => void;
}

const AutomationFormDialog = ({
  draft,
  saving,
  onDraftChange,
  onClose,
  onSubmit,
}: AutomationFormDialogProps) => {
  const { LL } = useI18nContext();
  const editing = Boolean(draft.id);
  const canSubmit =
    Boolean(draft.title.trim()) &&
    Boolean(draft.prompt.trim()) &&
    Boolean(draft.scheduleValue.trim());

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!canSubmit || saving) return;
    onSubmit();
  };

  return (
    <Dialog
      open
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !saving) onClose();
      }}
    >
      <DialogContent className="flex! flex-col gap-0! overflow-hidden bg-background! p-0! text-foreground! shadow-2xl w-[560px]! max-w-[calc(100vw-32px)]!">
        <div className="border-b border-border px-5 py-4 pr-12">
          <DialogTitle className="text-sm font-medium text-foreground">
            {editing
              ? LL.automations_editTitle()
              : LL.automations_createTitle()}
          </DialogTitle>
          <DialogDescription className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {LL.automations_description()}
          </DialogDescription>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="max-h-[calc(100vh-220px)] space-y-3 overflow-y-auto px-5 py-4">
            <div>
              <label
                htmlFor="automation-title"
                className="mb-1 block text-xs text-muted-foreground"
              >
                {LL.automations_name()}
              </label>
              <input
                id="automation-title"
                value={draft.title}
                onChange={(event) =>
                  onDraftChange({ ...draft, title: event.target.value })
                }
                className={inputCls}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label
                  htmlFor="automation-type"
                  className="mb-1 block text-xs text-muted-foreground"
                >
                  {LL.automations_type()}
                </label>
                <select
                  id="automation-type"
                  value={draft.type}
                  onChange={(event) =>
                    onDraftChange({
                      ...draft,
                      type: event.target.value as AutomationType,
                    })
                  }
                  className={inputCls}
                >
                  {Object.entries(typeLabels(LL)).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label
                  htmlFor="automation-run-mode"
                  className="mb-1 block text-xs text-muted-foreground"
                >
                  {LL.automations_runMode()}
                </label>
                <select
                  id="automation-run-mode"
                  value={draft.runMode}
                  disabled={draft.type !== "project"}
                  onChange={(event) =>
                    onDraftChange({
                      ...draft,
                      runMode: event.target.value as AutomationRunMode,
                    })
                  }
                  className={`${inputCls} disabled:opacity-50`}
                >
                  {Object.entries(runModeLabels(LL)).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label
                  htmlFor="automation-schedule-kind"
                  className="mb-1 block text-xs text-muted-foreground"
                >
                  {LL.automations_scheduleKind()}
                </label>
                <select
                  id="automation-schedule-kind"
                  value={draft.scheduleKind}
                  onChange={(event) =>
                    onDraftChange({
                      ...draft,
                      scheduleKind: event.target
                        .value as AutomationScheduleKind,
                    })
                  }
                  className={inputCls}
                >
                  {Object.entries(scheduleKindLabels(LL)).map(
                    ([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ),
                  )}
                </select>
              </div>

              <div>
                <label
                  htmlFor="automation-schedule-value"
                  className="mb-1 block text-xs text-muted-foreground"
                >
                  {LL.automations_scheduleValue()}
                </label>
                <input
                  id="automation-schedule-value"
                  value={draft.scheduleValue}
                  onChange={(event) =>
                    onDraftChange({
                      ...draft,
                      scheduleValue: event.target.value,
                    })
                  }
                  className={inputCls}
                />
              </div>
            </div>

            <div>
              <label
                htmlFor="automation-prompt"
                className="mb-1 block text-xs text-muted-foreground"
              >
                {LL.automations_prompt()}
              </label>
              <textarea
                id="automation-prompt"
                value={draft.prompt}
                rows={4}
                onChange={(event) =>
                  onDraftChange({ ...draft, prompt: event.target.value })
                }
                className={`${inputCls} resize-y leading-relaxed`}
              />
            </div>

            <div>
              <label
                htmlFor="automation-workspace-paths"
                className="mb-1 block text-xs text-muted-foreground"
              >
                {LL.automations_workspacePaths()}
              </label>
              <textarea
                id="automation-workspace-paths"
                value={draft.workspacePathsText}
                rows={2}
                disabled={draft.type !== "project"}
                placeholder={LL.automations_workspacePathsPlaceholder()}
                onChange={(event) =>
                  onDraftChange({
                    ...draft,
                    workspacePathsText: event.target.value,
                  })
                }
                className={`${inputCls} resize-y font-mono text-xs disabled:opacity-50`}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label
                  htmlFor="automation-model"
                  className="mb-1 block text-xs text-muted-foreground"
                >
                  {LL.automations_modelId()}
                </label>
                <input
                  id="automation-model"
                  value={draft.modelId}
                  onChange={(event) =>
                    onDraftChange({ ...draft, modelId: event.target.value })
                  }
                  className={inputCls}
                />
              </div>
              <div>
                <label
                  htmlFor="automation-reasoning"
                  className="mb-1 block text-xs text-muted-foreground"
                >
                  {LL.automations_reasoningEffort()}
                </label>
                <input
                  id="automation-reasoning"
                  value={draft.reasoningEffort}
                  onChange={(event) =>
                    onDraftChange({
                      ...draft,
                      reasoningEffort: event.target.value,
                    })
                  }
                  className={inputCls}
                />
              </div>
            </div>

            <label className="flex items-center gap-2 text-xs text-foreground">
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(event) =>
                  onDraftChange({ ...draft, enabled: event.target.checked })
                }
                className="h-4 w-4 accent-primary"
              />
              {LL.automations_enabled()}
            </label>
          </div>

          <div className="flex justify-end gap-2 border-t border-border bg-muted/30 px-5 py-3">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="rounded-lg border border-border bg-background px-4 py-1.5 text-xs text-muted-foreground hover:bg-accent disabled:opacity-50"
            >
              {LL.automations_cancel()}
            </button>
            <button
              type="submit"
              disabled={saving || !canSubmit}
              className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-1.5 text-xs text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              {saving && <Loader2 className="h-3 w-3 animate-spin" />}
              {LL.automations_save()}
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
};

interface AutomationDeleteDialogProps {
  automation: AutomationRecord | null;
  onCancel: () => void;
  onConfirm: () => Promise<void> | void;
}

export const AutomationDeleteDialogContent = ({
  automation,
  onCancel,
  onConfirm,
  TitleComponent = "h2",
  DescriptionComponent = "p",
}: {
  automation: AutomationRecord;
  onCancel: () => void;
  onConfirm: () => Promise<void> | void;
  TitleComponent?: ElementType;
  DescriptionComponent?: ElementType;
}) => {
  const { LL } = useI18nContext();

  return (
    <>
      <div className="border-b border-border px-4 py-3">
        <TitleComponent className="pr-8 text-sm font-medium">
          {LL.automations_deleteConfirmTitle()}
        </TitleComponent>
        <DescriptionComponent className="mt-1 text-xs leading-relaxed text-muted-foreground">
          {LL.automations_deleteConfirmDesc()}
        </DescriptionComponent>
      </div>
      <div className="px-4 py-3">
        <p className="truncate text-sm font-medium text-foreground">
          {automation.title}
        </p>
        <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
          {automation.prompt}
        </p>
      </div>
      <div className="flex justify-end gap-2 border-t border-border px-4 py-3">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md px-3 py-1.5 text-sm text-foreground hover:bg-accent"
        >
          {LL.automations_cancel()}
        </button>
        <button
          type="button"
          onClick={() => void onConfirm()}
          className="rounded-md bg-destructive px-3 py-1.5 text-sm text-destructive-foreground hover:opacity-90"
        >
          {LL.automations_delete()}
        </button>
      </div>
    </>
  );
};

export const AutomationDeleteDialog = ({
  automation,
  onCancel,
  onConfirm,
}: AutomationDeleteDialogProps) => {
  return (
    <Dialog
      open={automation !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      {automation && (
        <DialogContent className="gap-0! overflow-hidden bg-background! p-0! text-foreground! shadow-lg w-full! max-w-sm!">
          <AutomationDeleteDialogContent
            automation={automation}
            onCancel={onCancel}
            onConfirm={onConfirm}
            TitleComponent={DialogTitle}
            DescriptionComponent={DialogDescription}
          />
        </DialogContent>
      )}
    </Dialog>
  );
};

export const AutomationRunDetailDialogContent = ({
  run,
  TitleComponent = "h2",
  DescriptionComponent = "p",
}: {
  run: AutomationRunRecord;
  TitleComponent?: ElementType;
  DescriptionComponent?: ElementType;
}) => {
  const { LL, locale } = useI18nContext();
  const runStatusLabels = automationRunStatusLabels(LL);
  const startedAt = formatDateTime(run.startedAt, locale);
  const completedAt = formatDateTime(run.completedAt, locale);
  const workspacePaths = run.workspacePaths?.join("\n") ?? "-";
  const tokenParts = [
    run.inputTokens !== null
      ? LL.automations_tokenInput({ value: formatTokens(run.inputTokens) })
      : null,
    run.outputTokens !== null
      ? LL.automations_tokenOutput({ value: formatTokens(run.outputTokens) })
      : null,
    run.totalTokens !== null
      ? LL.automations_tokenTotal({ value: formatTokens(run.totalTokens) })
      : null,
  ].filter(Boolean);

  return (
    <>
      <div className="border-b border-border px-5 py-4 pr-12">
        <TitleComponent className="text-sm font-medium text-foreground">
          {LL.automations_runDetailTitle()}
        </TitleComponent>
        <DescriptionComponent className="mt-1 text-xs leading-relaxed text-muted-foreground">
          {run.automationTitle}
        </DescriptionComponent>
      </div>
      <div
        className="max-h-[calc(100vh-160px)] space-y-5 overflow-y-auto px-6 py-5"
        data-automation-run-detail-layout="expanded"
      >
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] ${automationRunStatusClass(run.status)}`}
          >
            {runStatusLabels[run.status]}
          </span>
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
            {run.trigger === "manual"
              ? LL.automations_triggerManual()
              : LL.automations_triggerScheduled()}
          </span>
        </div>

        <div className="grid grid-cols-2 gap-4 text-xs sm:grid-cols-4">
          <div>
            <div className="text-muted-foreground">
              {LL.automations_runStartedLabel()}
            </div>
            <div className="mt-1 text-foreground">{startedAt ?? "-"}</div>
          </div>
          <div>
            <div className="text-muted-foreground">
              {LL.automations_runCompletedLabel()}
            </div>
            <div className="mt-1 text-foreground">{completedAt ?? "-"}</div>
          </div>
          <div>
            <div className="text-muted-foreground">
              {LL.automations_runDetailTokens()}
            </div>
            <div className="mt-1 text-foreground">
              {tokenParts.length ? tokenParts.join(" · ") : "-"}
            </div>
          </div>
          <div>
            <div className="text-muted-foreground">ID</div>
            <div className="mt-1 truncate font-mono text-[11px] text-foreground">
              {run.id}
            </div>
          </div>
        </div>

        <section>
          <h4 className="mb-1 text-xs font-medium text-muted-foreground">
            {LL.automations_runDetailWorkspace()}
          </h4>
          <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted/40 p-3 text-xs text-foreground">
            {workspacePaths}
          </pre>
        </section>

        <section>
          <h4 className="mb-1 text-xs font-medium text-muted-foreground">
            {LL.automations_runDetailPrompt()}
          </h4>
          <pre className="max-h-44 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted/40 p-3 text-xs text-foreground">
            {run.prompt}
          </pre>
        </section>

        {run.errorMessage && (
          <section>
            <h4 className="mb-1 text-xs font-medium text-destructive">
              {LL.automations_runDetailError()}
            </h4>
            <pre className="max-h-44 overflow-auto whitespace-pre-wrap rounded-md border border-destructive/20 bg-destructive/5 p-3 text-xs text-destructive">
              {run.errorMessage}
            </pre>
          </section>
        )}

        {run.output && (
          <section>
            <h4 className="mb-1 text-xs font-medium text-muted-foreground">
              {LL.automations_runDetailOutput()}
            </h4>
            <div
              className="min-h-48 max-h-[min(62vh,560px)] overflow-auto rounded-md border border-border bg-background p-4 text-sm text-foreground"
              data-automation-run-output-markdown="true"
            >
              <MessageResponse className="text-sm leading-relaxed [&_pre]:text-xs">
                {run.output}
              </MessageResponse>
            </div>
          </section>
        )}
      </div>
    </>
  );
};

export const AutomationsPanel = ({
  initialAutomations,
  initialRuns,
  initialView = "tasks",
  onTriggerAutomation,
  onAfterTriggerAutomation,
  runningAutomationId,
  variant = "full",
}: AutomationsPanelProps) => {
  const { LL, locale } = useI18nContext();
  const [automations, setAutomations] = useState<AutomationRecord[]>(
    initialAutomations ?? [],
  );
  const [runs, setRuns] = useState<AutomationRunRecord[]>(initialRuns ?? []);
  const [loading, setLoading] = useState(initialAutomations === undefined);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<AutomationDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [triggeringId, setTriggeringId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<AutomationRecord | null>(
    null,
  );
  const [view, setView] = useState<AutomationView>(initialView);
  const [selectedRun, setSelectedRun] = useState<AutomationRunRecord | null>(
    null,
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [items, recentRuns] = await Promise.all([
        window.filework.automations.list(),
        window.filework.automations.listRuns({ limit: 20 }),
      ]);
      setAutomations(items);
      setRuns(recentRuns);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (initialAutomations !== undefined) return;
    void refresh();
  }, [initialAutomations, refresh]);

  useEffect(() => {
    if (initialAutomations !== undefined) return;
    const timer = window.setInterval(() => {
      void refresh();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [initialAutomations, refresh]);

  const openCreate = () => setDraft(EMPTY_DRAFT);
  const openEdit = (automation: AutomationRecord) =>
    setDraft(draftFromAutomation(automation));

  const handleSave = async () => {
    if (!draft) return;
    const title = draft.title.trim();
    const prompt = draft.prompt.trim();
    const scheduleValue = draft.scheduleValue.trim();
    if (!title || !prompt || !scheduleValue) {
      setError(LL.automations_errorRequired());
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const workspacePaths =
        draft.type === "project"
          ? parseWorkspacePaths(draft.workspacePathsText)
          : null;
      const runMode = draft.type === "project" ? draft.runMode : null;
      const payload = {
        title,
        prompt,
        type: draft.type,
        scheduleKind: draft.scheduleKind,
        scheduleValue,
        enabled: draft.enabled,
        workspacePaths,
        runMode,
        modelId: draft.modelId.trim() || null,
        reasoningEffort: draft.reasoningEffort.trim() || null,
      };
      if (draft.id) {
        await window.filework.automations.update(draft.id, payload);
      } else {
        await window.filework.automations.create(payload);
      }
      setDraft(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async (automation: AutomationRecord) => {
    setError(null);
    try {
      await window.filework.automations.update(automation.id, {
        enabled: !automation.enabled,
      });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleDelete = async (id: string) => {
    setError(null);
    try {
      await window.filework.automations.delete(id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleConfirmDelete = async () => {
    if (!pendingDelete) return;
    const id = pendingDelete.id;
    setPendingDelete(null);
    await handleDelete(id);
  };

  const handleTrigger = async (automation: AutomationRecord) => {
    setTriggeringId(automation.id);
    setError(null);
    let resetTriggering = true;
    try {
      await onTriggerAutomation?.(automation);
      await window.filework.automations.trigger(automation.id);
      await refresh();
      setTriggeringId(null);
      resetTriggering = false;
      onAfterTriggerAutomation?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (resetTriggering) setTriggeringId(null);
    }
  };

  const labels = typeLabels(LL);
  const scheduleLabels = scheduleKindLabels(LL);
  const runModes = runModeLabels(LL);
  const runStatusLabels = automationRunStatusLabels(LL);
  const activeRunAutomationIds = new Set(
    runs.filter(isActiveAutomationRun).map((run) => run.automationId),
  );
  const isRail = variant === "rail";
  const formDialog = draft ? (
    <AutomationFormDialog
      draft={draft}
      saving={saving}
      onDraftChange={setDraft}
      onClose={() => {
        if (!saving) setDraft(null);
      }}
      onSubmit={handleSave}
    />
  ) : null;
  const runDetailDialog = (
    <Dialog
      open={selectedRun !== null}
      onOpenChange={(open) => {
        if (!open) setSelectedRun(null);
      }}
    >
      {selectedRun && (
        <DialogContent
          className="flex! max-h-[calc(100vh-48px)]! flex-col gap-0! overflow-hidden bg-background! p-0! text-foreground! shadow-2xl w-[840px]! max-w-[calc(100vw-48px)]!"
          data-automation-run-detail-size="wide"
        >
          <AutomationRunDetailDialogContent
            run={selectedRun}
            TitleComponent={DialogTitle}
            DescriptionComponent={DialogDescription}
          />
        </DialogContent>
      )}
    </Dialog>
  );
  const triageSection = (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {LL.automations_triageTitle()}
        </h4>
        {runs.some(isActiveAutomationRun) && (
          <span className="inline-flex items-center gap-1 rounded bg-sky-500/10 px-1.5 py-0.5 text-[10px] text-sky-700 dark:text-sky-300">
            <Loader2 className="h-2.5 w-2.5 animate-spin" />
            {LL.automations_runStatusRunning()}
          </span>
        )}
      </div>
      {runs.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
          {LL.automations_runsEmpty()}
        </div>
      ) : (
        <div
          data-automation-triage-list="true"
          className="overflow-hidden rounded-lg border border-border"
        >
          {runs.slice(0, 8).map((run) => {
            const startedAt = formatDateTime(run.startedAt, locale);
            const completedAt = formatDateTime(run.completedAt, locale);
            const summary = run.errorMessage ?? run.output ?? run.prompt;
            return (
              <button
                type="button"
                key={run.id}
                data-automation-run-status={run.status}
                onClick={() => setSelectedRun(run)}
                className="block w-full border-border px-3 py-2.5 text-left transition-colors hover:bg-accent/60 not-last:border-b"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <span
                    className={`inline-flex shrink-0 items-center rounded border px-1.5 py-0.5 text-[10px] ${automationRunStatusClass(run.status)}`}
                  >
                    {runStatusLabels[run.status]}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
                    {run.automationTitle}
                  </span>
                  <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                    {run.trigger === "manual"
                      ? LL.automations_triggerManual()
                      : LL.automations_triggerScheduled()}
                  </span>
                  <span className="inline-flex shrink-0 items-center gap-1 rounded bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground">
                    <FileText className="h-2.5 w-2.5" />
                    {LL.automations_viewDetails()}
                  </span>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
                  {startedAt && (
                    <span>
                      {LL.automations_runStarted({ value: startedAt })}
                    </span>
                  )}
                  {completedAt && (
                    <span>
                      {LL.automations_runCompleted({ value: completedAt })}
                    </span>
                  )}
                  {run.totalTokens !== null && (
                    <span>
                      {LL.automations_tokenTotal({
                        value: formatTokens(run.totalTokens),
                      })}
                    </span>
                  )}
                </div>
                <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                  {summary}
                </p>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
  const taskListSection = loading ? (
    <div className="flex items-center gap-2 text-sm text-muted-foreground">
      <Loader2 className="h-3.5 w-3.5 animate-spin" />
      {LL.automations_loading()}
    </div>
  ) : automations.length === 0 ? (
    <div className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-xs text-muted-foreground">
      {LL.automations_empty()}
    </div>
  ) : (
    <div className="overflow-hidden rounded-lg border border-border">
      {automations.map((automation) => {
        const lastRun = formatDateTime(automation.lastRunAt, locale);
        const nextRun = formatDateTime(automation.nextRunAt, locale);
        const isRunning =
          runningAutomationId === automation.id ||
          triggeringId === automation.id ||
          activeRunAutomationIds.has(automation.id);
        const status = automationStatus(automation, LL);
        return (
          <div
            key={automation.id}
            data-automation-running={isRunning ? "true" : undefined}
            data-automation-enabled={automation.enabled ? "true" : "false"}
            className={`flex items-center gap-3 border-border px-3 py-3 transition-colors not-last:border-b ${status.rowClass}`}
          >
            <div
              className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${status.iconClass}`}
            >
              <CalendarClock className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-1.5 text-sm">
                <span
                  className={`h-2 w-2 shrink-0 rounded-full ${status.dotClass}`}
                />
                <span className={`truncate font-medium ${status.titleClass}`}>
                  {automation.title}
                </span>
                <span
                  className={`inline-flex shrink-0 items-center rounded border px-1.5 py-0.5 text-[10px] ${status.pillClass}`}
                >
                  {status.label}
                </span>
                <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground/70">
                  {labels[automation.type]}
                </span>
                {isRunning && (
                  <span className="inline-flex shrink-0 items-center gap-1 rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-emerald-700 dark:text-emerald-300">
                    <Loader2 className="h-2.5 w-2.5 animate-spin" />
                    {LL.task_running()}
                  </span>
                )}
              </div>
              <div
                className={`mt-0.5 line-clamp-1 text-xs ${status.bodyClass}`}
              >
                {automation.prompt}
              </div>
              <div
                className={`mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs ${status.bodyClass}`}
              >
                <span>
                  {scheduleLabels[automation.scheduleKind]} ·{" "}
                  {automation.scheduleValue}
                </span>
                {automation.type === "project" && automation.runMode && (
                  <span>{runModes[automation.runMode]}</span>
                )}
                {lastRun && (
                  <span>{LL.automations_lastRun({ value: lastRun })}</span>
                )}
                <span>
                  {nextRun
                    ? LL.automations_nextRun({ value: nextRun })
                    : LL.automations_notScheduled()}
                </span>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                onClick={() => handleTrigger(automation)}
                disabled={isRunning}
                className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
                title={isRunning ? LL.task_running() : LL.automations_trigger()}
                aria-label={LL.automations_trigger()}
              >
                {isRunning ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Play className="h-3.5 w-3.5" />
                )}
              </button>
              <button
                type="button"
                onClick={() => handleToggle(automation)}
                className={`inline-flex h-7 w-7 items-center justify-center rounded-lg ${status.toggleClass}`}
                title={
                  automation.enabled
                    ? LL.automations_disable()
                    : LL.automations_enable()
                }
                aria-label={
                  automation.enabled
                    ? LL.automations_disable()
                    : LL.automations_enable()
                }
              >
                <Power className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => openEdit(automation)}
                className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground"
                title={LL.automations_edit()}
                aria-label={LL.automations_edit()}
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => setPendingDelete(automation)}
                className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-destructive hover:bg-destructive/10"
                title={LL.automations_delete()}
                aria-label={LL.automations_delete()}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );

  if (isRail) {
    const enabledCount = automations.filter(
      (automation) => automation.enabled,
    ).length;

    return (
      <div
        data-automation-rail="true"
        className="border-b border-border px-2 pb-2"
      >
        <div className="flex items-center justify-between gap-2 px-1 py-2">
          <div className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-foreground">
            <CalendarClock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{LL.automations_title()}</span>
            {!loading && automations.length > 0 && (
              <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] font-normal text-muted-foreground">
                {enabledCount}/{automations.length}
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={openCreate}
            className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            title={LL.automations_add()}
            aria-label={LL.automations_add()}
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        </div>

        {error && (
          <div className="mb-2 rounded-md border border-destructive/30 bg-destructive/5 px-2 py-1.5">
            <div className="flex items-start gap-1.5">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
              <div className="line-clamp-2 text-[11px] leading-relaxed text-destructive">
                {error}
              </div>
            </div>
          </div>
        )}

        {loading ? (
          <div className="flex items-center gap-1.5 px-1 py-1 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {LL.automations_loading()}
          </div>
        ) : automations.length === 0 ? (
          <div className="rounded-md border border-dashed border-border px-2 py-3 text-center text-xs text-muted-foreground">
            {LL.automations_empty()}
          </div>
        ) : (
          <div className="max-h-52 space-y-1 overflow-y-auto pr-0.5">
            {automations.map((automation) => {
              const lastRun = formatDateTime(automation.lastRunAt, locale);
              const nextRun = formatDateTime(automation.nextRunAt, locale);
              const isRunning =
                runningAutomationId === automation.id ||
                triggeringId === automation.id ||
                activeRunAutomationIds.has(automation.id);
              const status = automationStatus(automation, LL);
              return (
                <div
                  key={automation.id}
                  data-automation-running={isRunning ? "true" : undefined}
                  data-automation-enabled={
                    automation.enabled ? "true" : "false"
                  }
                  className={`rounded-md border px-2 py-2 transition-colors ${status.rowClass}`}
                >
                  <div className="flex min-w-0 items-start gap-2">
                    <span
                      className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${status.dotClass}`}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <span
                          className={`truncate text-xs font-medium ${status.titleClass}`}
                        >
                          {automation.title}
                        </span>
                        <span
                          className={`inline-flex shrink-0 items-center rounded border px-1 py-0.5 text-[10px] ${status.pillClass}`}
                        >
                          {status.label}
                        </span>
                        <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
                          {labels[automation.type]}
                        </span>
                        {isRunning && (
                          <span className="inline-flex shrink-0 items-center gap-1 rounded bg-emerald-500/10 px-1 py-0.5 text-[10px] text-emerald-700 dark:text-emerald-300">
                            <Loader2 className="h-2.5 w-2.5 animate-spin" />
                            {LL.task_running()}
                          </span>
                        )}
                      </div>
                      <div
                        className={`mt-0.5 truncate text-[11px] ${status.bodyClass}`}
                      >
                        {scheduleLabels[automation.scheduleKind]} ·{" "}
                        {automation.scheduleValue}
                      </div>
                      {lastRun && (
                        <div
                          className={`truncate text-[11px] ${status.bodyClass}`}
                        >
                          {LL.automations_lastRun({ value: lastRun })}
                        </div>
                      )}
                      <div
                        className={`truncate text-[11px] ${status.bodyClass}`}
                      >
                        {nextRun
                          ? LL.automations_nextRun({ value: nextRun })
                          : LL.automations_notScheduled()}
                      </div>
                    </div>
                  </div>
                  <div className="mt-1.5 flex items-center justify-end gap-0.5">
                    <button
                      type="button"
                      onClick={() => handleTrigger(automation)}
                      disabled={isRunning}
                      className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
                      title={
                        isRunning ? LL.task_running() : LL.automations_trigger()
                      }
                      aria-label={LL.automations_trigger()}
                    >
                      {isRunning ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Play className="h-3.5 w-3.5" />
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleToggle(automation)}
                      className={`inline-flex size-6 items-center justify-center rounded-md ${status.toggleClass}`}
                      title={
                        automation.enabled
                          ? LL.automations_disable()
                          : LL.automations_enable()
                      }
                      aria-label={
                        automation.enabled
                          ? LL.automations_disable()
                          : LL.automations_enable()
                      }
                    >
                      <Power className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => openEdit(automation)}
                      className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                      title={LL.automations_edit()}
                      aria-label={LL.automations_edit()}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setPendingDelete(automation)}
                      className="inline-flex size-6 items-center justify-center rounded-md text-destructive hover:bg-destructive/10"
                      title={LL.automations_delete()}
                      aria-label={LL.automations_delete()}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {formDialog}
        <AutomationDeleteDialog
          automation={pendingDelete}
          onCancel={() => setPendingDelete(null)}
          onConfirm={handleConfirmDelete}
        />
      </div>
    );
  }

  return (
    <div data-automation-view={view} className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-foreground">
            {LL.automations_title()}
          </h3>
          <p className="mt-1 max-w-3xl text-xs leading-relaxed text-muted-foreground">
            {LL.automations_description()}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {view === "tasks" && (
            <button
              type="button"
              onClick={openCreate}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-1.5 text-xs text-foreground hover:bg-accent"
            >
              <Plus className="h-3.5 w-3.5" />
              {LL.automations_add()}
            </button>
          )}
          <div className="inline-flex rounded-lg border border-border bg-muted/40 p-0.5">
            <button
              type="button"
              onClick={() => setView("tasks")}
              className={`rounded-md px-2.5 py-1 text-xs transition-colors ${
                view === "tasks"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {LL.automations_showTasks()}
            </button>
            <button
              type="button"
              onClick={() => setView("triage")}
              className={`rounded-md px-2.5 py-1 text-xs transition-colors ${
                view === "triage"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {LL.automations_showTriage()}
            </button>
          </div>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <div className="text-xs text-destructive">{error}</div>
          </div>
        </div>
      )}

      {view === "tasks" ? taskListSection : triageSection}

      {formDialog}
      {runDetailDialog}
      <AutomationDeleteDialog
        automation={pendingDelete}
        onCancel={() => setPendingDelete(null)}
        onConfirm={handleConfirmDelete}
      />
    </div>
  );
};
