import {
  AlertTriangle,
  CheckCircle2,
  KeyRound,
  Loader2,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { type FormEvent, useCallback, useEffect, useState } from "react";

import {
  CREDENTIAL_KIND_OPTIONS,
  type CredentialKind,
  credentialKindLabel,
} from "../../../shared/credentials";
import { useI18nContext } from "../../i18n/i18n-react";
import type { Locales, TranslationFunctions } from "../../i18n/i18n-types";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "../ui/dialog";

interface CredentialSummary {
  id: string;
  kind: CredentialKind;
  label: string;
  scopes: string[] | null;
  createdAt: string;
  // M7 — health monitor fields. NULL on credentials predating M7.
  lastTestedAt: string | null;
  testStatus: "unknown" | "ok" | "error" | null;
  lastTestError: string | null;
  lastTestedHost: string | null;
}

interface CredentialDraft {
  kind: CredentialKind;
  label: string;
  token: string;
}

type DialogMode = "create" | "edit";

const EMPTY_DRAFT: CredentialDraft = {
  kind: "github_pat",
  label: "",
  token: "",
};

const formatRelative = (
  iso: string | null,
  LL: TranslationFunctions,
): string => {
  if (!iso) return LL.credentials_relativeNever();
  const ms = Date.now() - Date.parse(iso);
  if (Number.isNaN(ms)) return LL.credentials_relativeUnknown();
  const min = Math.floor(ms / 60_000);
  if (min < 1) return LL.credentials_relativeJustNow();
  if (min < 60) return LL.credentials_relativeMinutes({ count: min });
  const hr = Math.floor(min / 60);
  if (hr < 24) return LL.credentials_relativeHours({ count: hr });
  const days = Math.floor(hr / 24);
  return LL.credentials_relativeDays({ count: days });
};

const statusDotClass = (status: CredentialSummary["testStatus"]): string => {
  if (status === "ok") return "bg-emerald-500";
  if (status === "error") return "bg-destructive";
  return "bg-muted-foreground/40";
};

const statusTooltip = (
  c: CredentialSummary,
  LL: TranslationFunctions,
): string => {
  if (c.testStatus === "ok")
    return LL.credentials_testedHealthy({
      when: formatRelative(c.lastTestedAt, LL),
    });
  if (c.testStatus === "error")
    return LL.credentials_testedError({
      error: c.lastTestError ?? LL.credentials_relativeUnknown(),
      when: formatRelative(c.lastTestedAt, LL),
    });
  return LL.credentials_notTested();
};

const formatDate = (iso: string, locale: Locales): string => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(
      date,
    );
  } catch {
    return date.toLocaleDateString();
  }
};

type TestState =
  | { state: "idle" }
  | { state: "testing" }
  | { state: "ok"; login?: string }
  | { state: "error"; error: string };

interface CredentialFormDialogProps {
  mode: DialogMode;
  draft: CredentialDraft;
  saving: boolean;
  onDraftChange: (draft: CredentialDraft) => void;
  onClose: () => void;
  onSubmit: () => void;
}

const CredentialFormDialog = ({
  mode,
  draft,
  saving,
  onDraftChange,
  onClose,
  onSubmit,
}: CredentialFormDialogProps) => {
  const { LL } = useI18nContext();
  const isEdit = mode === "edit";
  const tokenPlaceholder = isEdit
    ? LL.credentials_keepExistingToken()
    : (CREDENTIAL_KIND_OPTIONS.find((o) => o.value === draft.kind)
        ?.placeholder ?? "");
  const canSubmit =
    Boolean(draft.label.trim()) && (isEdit || Boolean(draft.token.trim()));
  const inputCls =
    "w-full rounded-lg border border-border bg-background px-2.5 py-2 text-sm text-foreground focus:border-primary focus:outline-none";

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
      <DialogContent className="flex! flex-col gap-0! overflow-hidden bg-background! p-0! text-foreground! shadow-2xl w-[460px]! max-w-[calc(100vw-32px)]!">
        <div className="border-b border-border px-5 py-4 pr-12">
          <DialogTitle className="text-sm font-medium text-foreground">
            {isEdit ? LL.credentials_editTitle() : LL.credentials_createTitle()}
          </DialogTitle>
          <DialogDescription className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {isEdit
              ? LL.credentials_keepExistingToken()
              : LL.credentials_tokenHint()}
          </DialogDescription>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="space-y-3 px-5 py-4">
            <div>
              <label
                htmlFor="credential-kind"
                className="mb-1 block text-xs text-muted-foreground"
              >
                {LL.credentials_kind()}
              </label>
              <select
                id="credential-kind"
                value={draft.kind}
                onChange={(event) =>
                  onDraftChange({
                    ...draft,
                    kind: event.target.value as CredentialKind,
                  })
                }
                className={inputCls}
              >
                {CREDENTIAL_KIND_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label
                htmlFor="credential-label"
                className="mb-1 block text-xs text-muted-foreground"
              >
                {LL.credentials_label()}
              </label>
              <input
                id="credential-label"
                type="text"
                value={draft.label}
                onChange={(event) =>
                  onDraftChange({ ...draft, label: event.target.value })
                }
                placeholder={LL.credentials_labelPlaceholder()}
                className={inputCls}
              />
            </div>

            <div>
              <label
                htmlFor="credential-token"
                className="mb-1 block text-xs text-muted-foreground"
              >
                {LL.credentials_token()}
              </label>
              <input
                id="credential-token"
                type="password"
                value={draft.token}
                onChange={(event) =>
                  onDraftChange({ ...draft, token: event.target.value })
                }
                placeholder={tokenPlaceholder}
                className={`${inputCls} font-mono`}
              />
            </div>
          </div>

          <div className="flex justify-end gap-2 border-t border-border bg-muted/30 px-5 py-3">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="rounded-lg border border-border bg-background px-4 py-1.5 text-xs text-muted-foreground hover:bg-accent disabled:opacity-50"
            >
              {LL.credentials_cancel()}
            </button>
            <button
              type="submit"
              disabled={saving || !canSubmit}
              className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-1.5 text-xs text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              {saving && <Loader2 className="h-3 w-3 animate-spin" />}
              {LL.credentials_save()}
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
};

export const CredentialsPanel = () => {
  const { LL, locale } = useI18nContext();
  const [list, setList] = useState<CredentialSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogMode, setDialogMode] = useState<DialogMode | null>(null);
  const [editing, setEditing] = useState<CredentialSummary | null>(null);
  const [draft, setDraft] = useState<CredentialDraft>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  const [tests, setTests] = useState<Record<string, TestState>>({});
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const items = await window.filework.credentials.list();
      setList(items);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const resetDialog = () => {
    setDialogMode(null);
    setEditing(null);
    setDraft(EMPTY_DRAFT);
  };

  const closeDialog = () => {
    if (saving) return;
    resetDialog();
  };

  const openCreate = () => {
    setEditing(null);
    setDraft(EMPTY_DRAFT);
    setDialogMode("create");
  };

  const openEdit = (credential: CredentialSummary) => {
    setEditing(credential);
    setDraft({
      kind: credential.kind,
      label: credential.label,
      token: "",
    });
    setDialogMode("edit");
  };

  const handleSave = async () => {
    if (!dialogMode) return;
    const label = draft.label.trim();
    const token = draft.token.trim();
    if (!label || (dialogMode === "create" && !token)) return;
    setSaving(true);
    setError(null);
    try {
      if (dialogMode === "edit" && editing) {
        await window.filework.credentials.update(editing.id, {
          kind: draft.kind,
          label,
          token: token || undefined,
        });
      } else {
        await window.filework.credentials.create({
          kind: draft.kind,
          label,
          token,
        });
      }
      resetDialog();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    setError(null);
    try {
      await window.filework.credentials.delete(id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleTest = async (id: string) => {
    setTests((prev) => ({ ...prev, [id]: { state: "testing" } }));
    try {
      const cred = list.find((c) => c.id === id);
      const res = await window.filework.credentials.test({
        id,
        kind: cred?.kind,
        host: cred?.lastTestedHost ?? undefined,
      });
      setTests((prev) => ({
        ...prev,
        [id]: res.ok
          ? { state: "ok", login: res.login }
          : {
              state: "error",
              error: res.error ?? LL.credentials_tokenInvalid(),
            },
      }));
      await refresh();
    } catch (err) {
      setTests((prev) => ({
        ...prev,
        [id]: {
          state: "error",
          error: err instanceof Error ? err.message : String(err),
        },
      }));
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="min-w-0 pr-4">
          <h3 className="text-sm font-semibold text-foreground">
            {LL.credentials_title()}
          </h3>
          <p className="mt-1 max-w-3xl text-xs leading-relaxed text-muted-foreground">
            {LL.credentials_description()}
          </p>
        </div>
        <button
          type="button"
          onClick={openCreate}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-1.5 text-xs text-foreground hover:bg-accent"
        >
          <Plus className="h-3.5 w-3.5" />
          {LL.credentials_addToken()}
        </button>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2">
          <div className="flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
            <div className="text-xs text-destructive">{error}</div>
          </div>
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          {LL.credentials_loading()}
        </div>
      ) : list.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-xs text-muted-foreground">
          {LL.credentials_empty()}
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border">
          {list.map((c) => {
            const t = tests[c.id] ?? { state: "idle" };
            return (
              <div
                key={c.id}
                className="flex items-center gap-3 border-border px-3 py-2.5 not-last:border-b"
              >
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                  <KeyRound className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-1.5 text-sm">
                    <span
                      className={`h-2 w-2 shrink-0 rounded-full ${statusDotClass(c.testStatus)}`}
                      title={statusTooltip(c, LL)}
                    />
                    <span className="truncate font-medium text-foreground">
                      {c.label}
                    </span>
                    <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground/70">
                      {credentialKindLabel(c.kind)}
                    </span>
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                    <span>
                      {LL.credentials_addedOn({
                        date: formatDate(c.createdAt, locale),
                      })}
                    </span>
                    {c.lastTestedHost && (
                      <span>
                        {LL.credentials_lastTestedHost({
                          host: c.lastTestedHost,
                        })}
                      </span>
                    )}
                    {c.scopes && c.scopes.length > 0 && (
                      <span>
                        {LL.credentials_scopes({
                          scopes: c.scopes.join(", "),
                        })}
                      </span>
                    )}
                    {t.state === "ok" && t.login && (
                      <span className="inline-flex items-center gap-0.5 text-emerald-600">
                        <CheckCircle2 className="h-3 w-3" />
                        {LL.credentials_connectedAs({ login: t.login })}
                      </span>
                    )}
                    {t.state === "error" && (
                      <span className="text-destructive">{t.error}</span>
                    )}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={() => handleTest(c.id)}
                    disabled={t.state === "testing"}
                    className="inline-flex h-7 items-center justify-center rounded-lg border border-border px-2 text-xs hover:bg-accent disabled:opacity-50"
                    title={
                      t.state === "testing"
                        ? LL.credentials_testing()
                        : LL.credentials_test()
                    }
                  >
                    {t.state === "testing" ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      LL.credentials_test()
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => openEdit(c)}
                    className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground"
                    title={LL.credentials_edit()}
                    aria-label={LL.credentials_edit()}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDelete(c.id)}
                    className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-destructive hover:bg-destructive/10"
                    title={LL.credentials_delete()}
                    aria-label={LL.credentials_delete()}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {dialogMode && (
        <CredentialFormDialog
          mode={dialogMode}
          draft={draft}
          saving={saving}
          onDraftChange={setDraft}
          onClose={closeDialog}
          onSubmit={handleSave}
        />
      )}
    </div>
  );
};
