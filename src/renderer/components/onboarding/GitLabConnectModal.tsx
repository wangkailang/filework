import {
  AlertTriangle,
  ChevronRight,
  Gitlab,
  KeyRound,
  Loader2,
  Plus,
  Search,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { WorkspaceRef } from "../../types/workspace-ref";

interface CredentialSummary {
  id: string;
  kind: "github_pat" | "gitlab_pat";
  label: string;
  scopes: string[] | null;
  createdAt: string;
}

interface ProjectSummary {
  fullPath: string;
  namespace: string;
  project: string;
  defaultBranch: string;
  visibility: "private" | "internal" | "public";
  description: string | null;
  lastActivityAt: string;
}

interface BranchSummary {
  name: string;
  protected: boolean;
}

interface Props {
  onCancel: () => void;
  onConfirm: (ref: WorkspaceRef) => void;
}

type Step = "credential" | "project" | "branch";

export const GitLabConnectModal = ({ onCancel, onConfirm }: Props) => {
  const [host, setHost] = useState("gitlab.com");
  const [credentials, setCredentials] = useState<CredentialSummary[]>([]);
  const [credentialId, setCredentialId] = useState<string | null>(null);
  const [step, setStep] = useState<Step>("credential");
  const [error, setError] = useState<string | null>(null);

  const [newLabel, setNewLabel] = useState("");
  const [newToken, setNewToken] = useState("");
  const [creating, setCreating] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);

  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [projectFilter, setProjectFilter] = useState("");
  const [selectedProject, setSelectedProject] = useState<ProjectSummary | null>(
    null,
  );

  const [branches, setBranches] = useState<BranchSummary[]>([]);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [selectedBranch, setSelectedBranch] = useState<string | null>(null);

  useEffect(() => {
    window.filework.credentials
      .list()
      .then((list: CredentialSummary[]) => {
        const gitlabOnly = list.filter((c) => c.kind === "gitlab_pat");
        setCredentials(gitlabOnly);
        if (gitlabOnly.length === 0) setShowAddForm(true);
      })
      .catch((err: Error) => setError(err.message));
  }, []);

  const handleCreateCredential = async () => {
    if (!newToken.trim() || !newLabel.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const created = await window.filework.credentials.create({
        kind: "gitlab_pat",
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

  const handleProceedToProjects = async () => {
    if (!credentialId || !host.trim()) return;
    setStep("project");
    setProjectsLoading(true);
    setError(null);
    try {
      const list = await window.filework.gitlab.listProjects({
        credentialId,
        host: host.trim(),
      });
      setProjects(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setProjectsLoading(false);
    }
  };

  const handleSelectProject = async (project: ProjectSummary) => {
    if (!credentialId) return;
    setSelectedProject(project);
    setStep("branch");
    setBranches([]);
    setSelectedBranch(project.defaultBranch);
    setBranchesLoading(true);
    setError(null);
    try {
      const list = await window.filework.gitlab.listBranches({
        credentialId,
        host: host.trim(),
        namespace: project.namespace,
        project: project.project,
      });
      setBranches(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBranchesLoading(false);
    }
  };

  const handleConfirm = () => {
    if (!credentialId || !selectedProject || !selectedBranch) return;
    const ref: WorkspaceRef = {
      kind: "gitlab",
      host: host.trim(),
      namespace: selectedProject.namespace,
      project: selectedProject.project,
      ref: selectedBranch,
      credentialId,
    };
    onConfirm(ref);
  };

  const filteredProjects = useMemo(() => {
    if (!projectFilter.trim()) return projects;
    const q = projectFilter.toLowerCase();
    return projects.filter(
      (p) =>
        p.fullPath.toLowerCase().includes(q) ||
        (p.description?.toLowerCase().includes(q) ?? false),
    );
  }, [projects, projectFilter]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="bg-background border border-border rounded-xl shadow-2xl w-full max-w-2xl max-h-[80vh] flex flex-col">
        <div className="px-5 py-4 border-b border-border flex items-center gap-2">
          <Gitlab className="w-5 h-5" />
          <h2 className="text-base font-semibold flex-1">
            Connect GitLab Repo
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

              <div>
                <label
                  htmlFor="gl-host"
                  className="block text-xs font-medium mb-1"
                >
                  Host
                </label>
                <input
                  id="gl-host"
                  type="text"
                  value={host}
                  onChange={(e) => setHost(e.target.value)}
                  placeholder="gitlab.com"
                  className="w-full px-2 py-1.5 text-sm rounded-md border border-border bg-background"
                />
                <div className="text-xs text-muted-foreground mt-1">
                  For self-hosted GitLab, paste the host (e.g.
                  <code className="ml-1">gitlab.example.com</code>).
                </div>
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
                      htmlFor="gl-cred-label"
                      className="block text-xs font-medium text-foreground mb-1"
                    >
                      Label
                    </label>
                    <input
                      id="gl-cred-label"
                      type="text"
                      value={newLabel}
                      onChange={(e) => setNewLabel(e.target.value)}
                      placeholder="e.g. work account"
                      className="w-full px-2 py-1.5 text-sm rounded-md border border-border bg-background"
                    />
                  </div>
                  <div>
                    <label
                      htmlFor="gl-cred-token"
                      className="block text-xs font-medium text-foreground mb-1"
                    >
                      Personal Access Token
                    </label>
                    <input
                      id="gl-cred-token"
                      type="password"
                      value={newToken}
                      onChange={(e) => setNewToken(e.target.value)}
                      placeholder="glpat-…"
                      className="w-full px-2 py-1.5 text-sm rounded-md border border-border bg-background font-mono"
                    />
                    <div className="text-xs text-muted-foreground mt-1">
                      Needs <code>api</code> scope (or <code>read_api</code> +
                      <code>write_repository</code> for fine-grained).
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

          {step === "project" && (
            <div className="space-y-3">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                <input
                  type="text"
                  value={projectFilter}
                  onChange={(e) => setProjectFilter(e.target.value)}
                  placeholder="Filter projects…"
                  className="w-full pl-8 pr-3 py-1.5 text-sm rounded-md border border-border bg-background"
                />
              </div>

              {projectsLoading ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground py-6 justify-center">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Loading projects…
                </div>
              ) : (
                <div className="space-y-1">
                  {filteredProjects.map((p) => (
                    <button
                      key={p.fullPath}
                      type="button"
                      onClick={() => handleSelectProject(p)}
                      className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-left text-sm hover:bg-accent transition-colors group"
                    >
                      <Gitlab className="w-4 h-4 text-muted-foreground shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="truncate text-foreground">
                          {p.fullPath}
                          {p.visibility !== "public" && (
                            <span className="ml-2 text-xs text-muted-foreground">
                              ({p.visibility})
                            </span>
                          )}
                        </div>
                        {p.description && (
                          <div className="truncate text-xs text-muted-foreground">
                            {p.description}
                          </div>
                        )}
                      </div>
                      <ChevronRight className="w-3.5 h-3.5 text-muted-foreground opacity-0 group-hover:opacity-100" />
                    </button>
                  ))}
                  {!projectsLoading && filteredProjects.length === 0 && (
                    <div className="text-sm text-muted-foreground py-6 text-center">
                      No projects found.
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {step === "branch" && selectedProject && (
            <div className="space-y-3">
              <div className="text-sm">
                <span className="text-muted-foreground">Project:</span>{" "}
                <span className="font-medium">{selectedProject.fullPath}</span>
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
                        {b.name === selectedProject.defaultBranch && (
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
              onClick={() => setStep("project")}
              className="px-3 py-1.5 text-sm border border-border rounded-md hover:bg-accent"
            >
              Back
            </button>
          )}
          {step === "project" && (
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
              onClick={handleProceedToProjects}
              disabled={!credentialId || !host.trim()}
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
              Open project
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
