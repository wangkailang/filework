import { Check, ChevronDown, GitBranch, Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkspaceRef } from "../../types/workspace-ref";

/**
 * BranchSwitcher — local-project style branch picker for github/gitlab
 * workspaces. Shows the current branch as a chip; clicking opens a
 * dropdown that fetches the project's branch list on demand and
 * dispatches `*:checkoutBranch` on selection.
 *
 * The dirty-tree refusal from `WorkspaceSCM.checkoutBranch` surfaces
 * as an inline error inside the dropdown — the user must commit or
 * discard their changes before retrying.
 */
interface BranchSwitcherProps {
  workspaceRef: WorkspaceRef;
  /** Current branch name. null = no chip (detached / non-git). */
  currentBranch: string | null;
  /** Called after a successful checkout. Receives the new branch name. */
  onSwitched: (newBranch: string) => void;
}

interface BranchOption {
  name: string;
  protected: boolean;
}

export const BranchSwitcher = ({
  workspaceRef,
  currentBranch,
  onSwitched,
}: BranchSwitcherProps) => {
  const [open, setOpen] = useState(false);
  const [branches, setBranches] = useState<BranchOption[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const loadBranches = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (workspaceRef.kind === "github") {
        const list = await window.filework.github.listBranches({
          credentialId: workspaceRef.credentialId,
          owner: workspaceRef.owner,
          repo: workspaceRef.repo,
        });
        setBranches(list);
      } else if (workspaceRef.kind === "gitlab") {
        const list = await window.filework.gitlab.listBranches({
          credentialId: workspaceRef.credentialId,
          host: workspaceRef.host,
          namespace: workspaceRef.namespace,
          project: workspaceRef.project,
        });
        setBranches(list);
      } else {
        const list = await window.filework.local.listBranches({
          path: workspaceRef.path,
        });
        setBranches(list);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [workspaceRef]);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  const handleToggle = () => {
    if (!open) {
      setOpen(true);
      if (!branches) void loadBranches();
    } else {
      setOpen(false);
    }
  };

  const handleSelect = async (branch: string) => {
    if (branch === currentBranch) {
      setOpen(false);
      return;
    }
    setSwitching(true);
    setError(null);
    try {
      if (workspaceRef.kind === "github") {
        await window.filework.github.checkoutBranch({
          credentialId: workspaceRef.credentialId,
          owner: workspaceRef.owner,
          repo: workspaceRef.repo,
          ref: workspaceRef.ref,
          branch,
        });
      } else if (workspaceRef.kind === "gitlab") {
        await window.filework.gitlab.checkoutBranch({
          credentialId: workspaceRef.credentialId,
          host: workspaceRef.host,
          namespace: workspaceRef.namespace,
          project: workspaceRef.project,
          ref: workspaceRef.ref,
          branch,
        });
      } else {
        await window.filework.local.checkoutBranch({
          path: workspaceRef.path,
          branch,
        });
      }
      onSwitched(branch);
      setOpen(false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Strip Electron's "Error invoking remote method ..." preamble
      // so the underlying DirtyTreeError message stays readable.
      setError(msg.replace(/^Error invoking remote method '[^']+':\s*/, ""));
    } finally {
      setSwitching(false);
    }
  };

  if (currentBranch === null) return null;

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={handleToggle}
        disabled={switching}
        className="flex items-center gap-1 px-1.5 py-0.5 rounded text-xs text-muted-foreground hover:bg-accent transition-colors max-w-[140px]"
        title={`Current branch: ${currentBranch}`}
      >
        {switching ? (
          <Loader2 className="w-3 h-3 animate-spin" />
        ) : (
          <GitBranch className="w-3 h-3 shrink-0" />
        )}
        <span className="truncate">{currentBranch}</span>
        <ChevronDown className="w-3 h-3 shrink-0 opacity-60" />
      </button>

      {open && (
        <div className="absolute top-full left-0 mt-1 w-64 max-h-72 overflow-y-auto rounded-md border border-border bg-popover shadow-lg z-50">
          {error && (
            <div className="px-3 py-2 text-xs text-destructive border-b border-border">
              {error}
            </div>
          )}
          {loading && (
            <div className="flex items-center justify-center px-3 py-4 text-xs text-muted-foreground">
              <Loader2 className="w-3 h-3 animate-spin mr-1.5" />
              Loading branches…
            </div>
          )}
          {!loading && branches && branches.length === 0 && (
            <div className="px-3 py-2 text-xs text-muted-foreground">
              No branches found.
            </div>
          )}
          {!loading &&
            branches?.map((b) => (
              <button
                key={b.name}
                type="button"
                onClick={() => handleSelect(b.name)}
                disabled={switching}
                className="w-full flex items-center justify-between px-3 py-1.5 text-xs hover:bg-accent text-left disabled:opacity-50"
              >
                <span className="truncate flex-1">
                  {b.name}
                  {b.protected && (
                    <span className="ml-1.5 text-[10px] text-muted-foreground">
                      (protected)
                    </span>
                  )}
                </span>
                {b.name === currentBranch && (
                  <Check className="w-3 h-3 shrink-0 ml-1.5" />
                )}
              </button>
            ))}
        </div>
      )}
    </div>
  );
};
