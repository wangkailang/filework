import { Check, ChevronDown, GitBranch, Loader2 } from "lucide-react";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { useI18nContext } from "../../i18n/i18n-react";
import { cn } from "../../lib/utils";
import type { WorkspaceRef } from "../../types/workspace-ref";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "../ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";

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
  className?: string;
  buttonClassName?: string;
}

interface BranchOption {
  name: string;
  protected: boolean;
}

export const BranchSwitcher = ({
  workspaceRef,
  currentBranch,
  onSwitched,
  className,
  buttonClassName,
}: BranchSwitcherProps) => {
  const { LL } = useI18nContext();
  const [open, setOpen] = useState(false);
  const [branches, setBranches] = useState<BranchOption[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      toast.success(LL.toast_branchSwitched({ branch }));
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
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (nextOpen && !branches && !loading) {
          void loadBranches();
        }
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={switching}
          className={cn(
            "flex max-w-full items-center gap-1.5 rounded-full border border-border px-2 py-0.5 font-mono text-xs text-muted-foreground transition-colors hover:border-border-strong hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
            buttonClassName,
            className,
          )}
          title={`Current branch: ${currentBranch}`}
        >
          <span className="size-1.5 shrink-0 rounded-full bg-status-success" />
          {switching ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <GitBranch className="size-3 shrink-0" />
          )}
          <span className="min-w-0 truncate">{currentBranch}</span>
          <ChevronDown
            className={cn(
              "size-3 shrink-0 opacity-60 transition-transform",
              open && "rotate-180",
            )}
          />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 gap-0 p-0" sideOffset={6}>
        <Command>
          <CommandInput placeholder="Search branches..." />
          {error && (
            <div className="border-b border-border px-3 py-2 text-xs text-destructive">
              {error}
            </div>
          )}
          {loading && (
            <div className="flex items-center justify-center px-3 py-4 text-xs text-muted-foreground">
              <Loader2 className="mr-1.5 size-3 animate-spin" />
              Loading branches…
            </div>
          )}
          {!loading && (
            <CommandList className="max-h-72 p-1">
              <CommandEmpty>
                {branches?.length === 0
                  ? "No branches found."
                  : "No matching branches."}
              </CommandEmpty>
              <CommandGroup heading="Branches">
                {branches?.map((branch) => (
                  <CommandItem
                    key={branch.name}
                    disabled={switching}
                    value={branch.name}
                    className="gap-2 font-mono text-xs"
                    onSelect={() => {
                      void handleSelect(branch.name);
                    }}
                  >
                    <GitBranch className="size-3.5 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">
                      {branch.name}
                    </span>
                    {branch.protected && (
                      <span className="rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
                        protected
                      </span>
                    )}
                    {branch.name === currentBranch && (
                      <Check className="size-3.5 shrink-0 text-primary" />
                    )}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          )}
        </Command>
      </PopoverContent>
    </Popover>
  );
};
