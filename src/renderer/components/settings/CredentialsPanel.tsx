import {
  AlertTriangle,
  CheckCircle2,
  KeyRound,
  Loader2,
  Plus,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

type CredentialKind =
  | "github_pat"
  | "gitlab_pat"
  | "tavily_pat"
  | "firecrawl_pat";

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

const KIND_OPTIONS: Array<{
  value: CredentialKind;
  label: string;
  placeholder: string;
}> = [
  {
    value: "github_pat",
    label: "GitHub",
    placeholder: "ghp_… or github_pat_…",
  },
  { value: "gitlab_pat", label: "GitLab", placeholder: "glpat-…" },
  { value: "tavily_pat", label: "Tavily", placeholder: "tvly-…" },
  { value: "firecrawl_pat", label: "Firecrawl", placeholder: "fc-…" },
];

const kindLabel = (kind: CredentialKind): string =>
  KIND_OPTIONS.find((o) => o.value === kind)?.label ?? kind;

const formatRelative = (iso: string | null): string => {
  if (!iso) return "never";
  const ms = Date.now() - Date.parse(iso);
  if (Number.isNaN(ms)) return "unknown";
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  return `${days}d ago`;
};

const statusDotClass = (status: CredentialSummary["testStatus"]): string => {
  if (status === "ok") return "bg-emerald-500";
  if (status === "error") return "bg-destructive";
  return "bg-muted-foreground/40";
};

const statusTooltip = (c: CredentialSummary): string => {
  if (c.testStatus === "ok")
    return `Healthy — tested ${formatRelative(c.lastTestedAt)}`;
  if (c.testStatus === "error")
    return `Error: ${c.lastTestError ?? "unknown"} (tested ${formatRelative(c.lastTestedAt)})`;
  return "Not tested yet";
};

type TestState =
  | { state: "idle" }
  | { state: "testing" }
  | { state: "ok"; login?: string }
  | { state: "error"; error: string };

export const CredentialsPanel = () => {
  const [list, setList] = useState<CredentialSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [newKind, setNewKind] = useState<CredentialKind>("github_pat");
  const [newLabel, setNewLabel] = useState("");
  const [newToken, setNewToken] = useState("");
  const [creating, setCreating] = useState(false);
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

  const handleCreate = async () => {
    if (!newToken.trim() || !newLabel.trim()) return;
    setCreating(true);
    setError(null);
    try {
      await window.filework.credentials.create({
        kind: newKind,
        label: newLabel.trim(),
        token: newToken.trim(),
      });
      setNewKind("github_pat");
      setNewLabel("");
      setNewToken("");
      setShowAdd(false);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
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
          : { state: "error", error: res.error ?? "Token invalid" },
      }));
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
        <div>
          <h3 className="text-sm font-semibold">Credentials</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            API keys / PATs for GitHub, GitLab, Tavily (web search), and
            Firecrawl (web scrape). Encrypted at rest with the same key as your
            LLM API keys.
          </p>
        </div>
        {!showAdd && (
          <button
            type="button"
            onClick={() => setShowAdd(true)}
            className="flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md border border-border hover:bg-accent"
          >
            <Plus className="w-3 h-3" /> Add token
          </button>
        )}
      </div>

      {error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2">
          <div className="flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
            <div className="text-xs text-destructive">{error}</div>
          </div>
        </div>
      )}

      {showAdd && (
        <div className="rounded-lg border border-border p-3 space-y-2">
          <div>
            <label
              htmlFor="add-kind"
              className="block text-xs font-medium mb-1"
            >
              Kind
            </label>
            <select
              id="add-kind"
              value={newKind}
              onChange={(e) => setNewKind(e.target.value as CredentialKind)}
              className="w-full px-2 py-1.5 text-sm rounded-md border border-border bg-background"
            >
              {KIND_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label
              htmlFor="add-label"
              className="block text-xs font-medium mb-1"
            >
              Label
            </label>
            <input
              id="add-label"
              type="text"
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              placeholder="e.g. work account"
              className="w-full px-2 py-1.5 text-sm rounded-md border border-border bg-background"
            />
          </div>
          <div>
            <label
              htmlFor="add-token"
              className="block text-xs font-medium mb-1"
            >
              Token
            </label>
            <input
              id="add-token"
              type="password"
              value={newToken}
              onChange={(e) => setNewToken(e.target.value)}
              placeholder={
                KIND_OPTIONS.find((o) => o.value === newKind)?.placeholder ?? ""
              }
              className="w-full px-2 py-1.5 text-sm rounded-md border border-border bg-background font-mono"
            />
          </div>
          <div className="flex gap-2 pt-1">
            <button
              type="button"
              onClick={handleCreate}
              disabled={creating || !newToken.trim() || !newLabel.trim()}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50"
            >
              {creating && <Loader2 className="w-3 h-3 animate-spin" />}
              Save
            </button>
            <button
              type="button"
              onClick={() => {
                setShowAdd(false);
                setNewKind("github_pat");
                setNewLabel("");
                setNewToken("");
              }}
              className="px-3 py-1.5 text-sm border border-border rounded-md hover:bg-accent"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          Loading…
        </div>
      ) : list.length === 0 ? (
        <div className="text-xs text-muted-foreground italic">
          No tokens stored yet.
        </div>
      ) : (
        <div className="space-y-1.5">
          {list.map((c) => {
            const t = tests[c.id] ?? { state: "idle" };
            return (
              <div
                key={c.id}
                className="flex items-center gap-3 px-3 py-2 rounded-lg border border-border"
              >
                <KeyRound className="w-4 h-4 text-muted-foreground shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 text-sm">
                    <span
                      className={`w-2 h-2 rounded-full shrink-0 ${statusDotClass(c.testStatus)}`}
                      title={statusTooltip(c)}
                    />
                    <span className="truncate">{c.label}</span>
                    <span className="text-[10px] uppercase tracking-wide text-muted-foreground/70 px-1.5 py-0.5 rounded bg-muted shrink-0">
                      {kindLabel(c.kind)}
                    </span>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Added {new Date(c.createdAt).toLocaleDateString()}
                    {t.state === "ok" && t.login && (
                      <span className="ml-2 inline-flex items-center gap-0.5 text-emerald-600">
                        <CheckCircle2 className="w-3 h-3" /> {t.login}
                      </span>
                    )}
                    {t.state === "error" && (
                      <span className="ml-2 text-destructive">{t.error}</span>
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => handleTest(c.id)}
                  disabled={t.state === "testing"}
                  className="px-2 py-1 text-xs rounded-md border border-border hover:bg-accent"
                >
                  {t.state === "testing" ? (
                    <Loader2 className="w-3 h-3 animate-spin" />
                  ) : (
                    "Test"
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => handleDelete(c.id)}
                  className="p-1.5 rounded-md hover:bg-destructive/10 text-destructive"
                  title="Delete"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
