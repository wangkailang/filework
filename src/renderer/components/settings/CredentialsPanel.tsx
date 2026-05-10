import {
  AlertTriangle,
  CheckCircle2,
  KeyRound,
  Loader2,
  Plus,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

interface CredentialSummary {
  id: string;
  kind: "github_pat";
  label: string;
  scopes: string[] | null;
  createdAt: string;
}

type TestState =
  | { state: "idle" }
  | { state: "testing" }
  | { state: "ok"; login?: string }
  | { state: "error"; error: string };

export const CredentialsPanel = () => {
  const [list, setList] = useState<CredentialSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
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
        kind: "github_pat",
        label: newLabel.trim(),
        token: newToken.trim(),
      });
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
      const res = await window.filework.credentials.test({ id });
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
          <h3 className="text-sm font-semibold">GitHub Tokens</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Personal access tokens for cloning private repos. Encrypted at rest
            with the same key as your LLM API keys.
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
              placeholder="ghp_… or github_pat_…"
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
                  <div className="text-sm truncate">{c.label}</div>
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
