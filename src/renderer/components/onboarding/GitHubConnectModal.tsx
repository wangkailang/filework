import {
  AlertTriangle,
  ChevronRight,
  Github,
  KeyRound,
  Loader2,
  Plus,
  Search,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { WorkspaceRef } from "../../types/workspace-ref";

interface CredentialSummary {
  id: string;
  kind: "github_pat";
  label: string;
  scopes: string[] | null;
  createdAt: string;
}

interface RepoSummary {
  fullName: string;
  owner: string;
  name: string;
  defaultBranch: string;
  private: boolean;
  description: string | null;
  updatedAt: string;
}

interface BranchSummary {
  name: string;
  protected: boolean;
}

interface Props {
  onCancel: () => void;
  onConfirm: (ref: WorkspaceRef) => void;
}

type Step = "credential" | "repo" | "branch";

export const GitHubConnectModal = ({ onCancel, onConfirm }: Props) => {
  const [credentials, setCredentials] = useState<CredentialSummary[]>([]);
  const [credentialId, setCredentialId] = useState<string | null>(null);
  const [step, setStep] = useState<Step>("credential");
  const [error, setError] = useState<string | null>(null);

  const [newLabel, setNewLabel] = useState("");
  const [newToken, setNewToken] = useState("");
  const [creating, setCreating] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);

  const [repos, setRepos] = useState<RepoSummary[]>([]);
  const [reposLoading, setReposLoading] = useState(false);
  const [repoFilter, setRepoFilter] = useState("");
  const [selectedRepo, setSelectedRepo] = useState<RepoSummary | null>(null);

  const [branches, setBranches] = useState<BranchSummary[]>([]);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [selectedBranch, setSelectedBranch] = useState<string | null>(null);

  useEffect(() => {
    window.filework.credentials
      .list()
      .then((list: CredentialSummary[]) => {
        setCredentials(list);
        if (list.length === 0) setShowAddForm(true);
      })
      .catch((err: Error) => setError(err.message));
  }, []);

  const handleCreateCredential = async () => {
    if (!newToken.trim() || !newLabel.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const created = await window.filework.credentials.create({
        kind: "github_pat",
        label: newLabel.trim(),
        token: newToken.trim(),
      });
      setCredentials((prev) => [...prev, created]);
      setCredentialId(created.id);
      setNewLabel("");
      setNewToken("");
      setShowAddForm(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  };

  const handleProceedToRepo = async () => {
    if (!credentialId) return;
    setStep("repo");
    setReposLoading(true);
    setError(null);
    try {
      const list = await window.filework.github.listRepos(credentialId);
      setRepos(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setReposLoading(false);
    }
  };

  const handleSelectRepo = async (repo: RepoSummary) => {
    if (!credentialId) return;
    setSelectedRepo(repo);
    setStep("branch");
    setBranches([]);
    setSelectedBranch(repo.defaultBranch);
    setBranchesLoading(true);
    setError(null);
    try {
      const list = await window.filework.github.listBranches({
        credentialId,
        owner: repo.owner,
        repo: repo.name,
      });
      setBranches(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBranchesLoading(false);
    }
  };

  const handleConfirm = () => {
    if (!credentialId || !selectedRepo || !selectedBranch) return;
    const ref: WorkspaceRef = {
      kind: "github",
      owner: selectedRepo.owner,
      repo: selectedRepo.name,
      ref: selectedBranch,
      credentialId,
    };
    onConfirm(ref);
  };

  const filteredRepos = useMemo(() => {
    if (!repoFilter.trim()) return repos;
    const q = repoFilter.toLowerCase();
    return repos.filter(
      (r) =>
        r.fullName.toLowerCase().includes(q) ||
        (r.description?.toLowerCase().includes(q) ?? false),
    );
  }, [repos, repoFilter]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="bg-background border border-border rounded-xl shadow-2xl w-full max-w-2xl max-h-[80vh] flex flex-col">
        <div className="px-5 py-4 border-b border-border flex items-center gap-2">
          <Github className="w-5 h-5" />
          <h2 className="text-base font-semibold flex-1">
            Connect GitHub Repo
          </h2>
          <button
            type="button"
            onClick={onCancel}
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            Cancel
          </button>
        </div>

        {error && (
          <div className="mx-5 mt-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2">
            <div className="flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
              <div className="text-xs text-destructive">{error}</div>
            </div>
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-5">
          {step === "credential" && (
            <div className="space-y-4">
              <div className="text-sm text-muted-foreground">
                Pick a personal access token, or paste a new one. Tokens are
                encrypted at rest with the same key as your LLM API keys.
              </div>

              {credentials.length > 0 && (
                <div className="space-y-1.5">
                  {credentials.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => setCredentialId(c.id)}
                      className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left text-sm border transition-colors ${
                        credentialId === c.id
                          ? "border-primary bg-primary/5"
                          : "border-border hover:bg-accent"
                      }`}
                    >
                      <KeyRound className="w-4 h-4 text-muted-foreground shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="truncate text-foreground">
                          {c.label}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          Added {new Date(c.createdAt).toLocaleDateString()}
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              )}

              {!showAddForm ? (
                <button
                  type="button"
                  onClick={() => setShowAddForm(true)}
                  className="flex items-center gap-1.5 text-sm text-primary hover:underline"
                >
                  <Plus className="w-3.5 h-3.5" />
                  Add new token
                </button>
              ) : (
                <div className="space-y-2 border border-border rounded-lg p-3">
                  <div>
                    <label
                      htmlFor="cred-label"
                      className="block text-xs font-medium text-foreground mb-1"
                    >
                      Label
                    </label>
                    <input
                      id="cred-label"
                      type="text"
                      value={newLabel}
                      onChange={(e) => setNewLabel(e.target.value)}
                      placeholder="e.g. work account"
                      className="w-full px-2 py-1.5 text-sm rounded-md border border-border bg-background"
                    />
                  </div>
                  <div>
                    <label
                      htmlFor="cred-token"
                      className="block text-xs font-medium text-foreground mb-1"
                    >
                      Personal Access Token
                    </label>
                    <input
                      id="cred-token"
                      type="password"
                      value={newToken}
                      onChange={(e) => setNewToken(e.target.value)}
                      placeholder="ghp_… or github_pat_…"
                      className="w-full px-2 py-1.5 text-sm rounded-md border border-border bg-background font-mono"
                    />
                    <div className="text-xs text-muted-foreground mt-1">
                      Needs <code>repo</code> scope (or fine-grained{" "}
                      <code>Contents: Read</code> for read-only).
                    </div>
                  </div>
                  <div className="flex gap-2 pt-1">
                    <button
                      type="button"
                      onClick={handleCreateCredential}
                      disabled={
                        creating || !newToken.trim() || !newLabel.trim()
                      }
                      className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50"
                    >
                      {creating && <Loader2 className="w-3 h-3 animate-spin" />}
                      Save token
                    </button>
                    {credentials.length > 0 && (
                      <button
                        type="button"
                        onClick={() => {
                          setShowAddForm(false);
                          setNewLabel("");
                          setNewToken("");
                        }}
                        className="px-3 py-1.5 text-sm border border-border rounded-md hover:bg-accent"
                      >
                        Cancel
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {step === "repo" && (
            <div className="space-y-3">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                <input
                  type="text"
                  value={repoFilter}
                  onChange={(e) => setRepoFilter(e.target.value)}
                  placeholder="Filter repos…"
                  className="w-full pl-8 pr-3 py-1.5 text-sm rounded-md border border-border bg-background"
                />
              </div>

              {reposLoading ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground py-6 justify-center">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Loading repositories…
                </div>
              ) : (
                <div className="space-y-1">
                  {filteredRepos.map((r) => (
                    <button
                      key={r.fullName}
                      type="button"
                      onClick={() => handleSelectRepo(r)}
                      className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-left text-sm hover:bg-accent transition-colors group"
                    >
                      <Github className="w-4 h-4 text-muted-foreground shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="truncate text-foreground">
                          {r.fullName}
                          {r.private && (
                            <span className="ml-2 text-xs text-muted-foreground">
                              (private)
                            </span>
                          )}
                        </div>
                        {r.description && (
                          <div className="truncate text-xs text-muted-foreground">
                            {r.description}
                          </div>
                        )}
                      </div>
                      <ChevronRight className="w-3.5 h-3.5 text-muted-foreground opacity-0 group-hover:opacity-100" />
                    </button>
                  ))}
                  {!reposLoading && filteredRepos.length === 0 && (
                    <div className="text-sm text-muted-foreground py-6 text-center">
                      No repositories found.
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {step === "branch" && selectedRepo && (
            <div className="space-y-3">
              <div className="text-sm">
                <span className="text-muted-foreground">Repository:</span>{" "}
                <span className="font-medium">{selectedRepo.fullName}</span>
              </div>
              {branchesLoading ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground py-6 justify-center">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Loading branches…
                </div>
              ) : (
                <div className="space-y-1 max-h-64 overflow-y-auto">
                  {branches.map((b) => (
                    <button
                      key={b.name}
                      type="button"
                      onClick={() => setSelectedBranch(b.name)}
                      className={`w-full flex items-center justify-between px-3 py-1.5 rounded-md text-left text-sm border transition-colors ${
                        selectedBranch === b.name
                          ? "border-primary bg-primary/5"
                          : "border-transparent hover:bg-accent"
                      }`}
                    >
                      <span>
                        {b.name}
                        {b.name === selectedRepo.defaultBranch && (
                          <span className="ml-2 text-xs text-muted-foreground">
                            (default)
                          </span>
                        )}
                      </span>
                      {b.protected && (
                        <span className="text-xs text-muted-foreground">
                          protected
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-border flex justify-end gap-2">
          {step === "branch" && (
            <button
              type="button"
              onClick={() => setStep("repo")}
              className="px-3 py-1.5 text-sm border border-border rounded-md hover:bg-accent"
            >
              Back
            </button>
          )}
          {step === "repo" && (
            <button
              type="button"
              onClick={() => setStep("credential")}
              className="px-3 py-1.5 text-sm border border-border rounded-md hover:bg-accent"
            >
              Back
            </button>
          )}
          {step === "credential" && (
            <button
              type="button"
              onClick={handleProceedToRepo}
              disabled={!credentialId}
              className="px-3 py-1.5 text-sm bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50"
            >
              Next
            </button>
          )}
          {step === "branch" && (
            <button
              type="button"
              onClick={handleConfirm}
              disabled={!selectedBranch}
              className="px-3 py-1.5 text-sm bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50"
            >
              Open repository
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
