import {
  AlertTriangle,
  Blocks,
  ChevronRight,
  FolderOpen,
  GitCompareArrows,
  Github,
  Gitlab,
  RefreshCw,
  Settings,
  X,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useI18nContext } from "../../i18n/i18n-react";
import type { Locales } from "../../i18n/i18n-types";
import {
  type WorkspaceRef,
  workspaceRefLabel,
} from "../../types/workspace-ref";
import {
  FileTree,
  FileTreeFile,
  FileTreeFolder,
} from "../ai-elements/file-tree";
import { useBranchDiff } from "../branch-diff/useBranchDiff";
import { SkillsModal } from "../skills/SkillsModal";
import { BranchSwitcher } from "./BranchSwitcher";
import { SettingsModal } from "./SettingsModal";

interface FileInfo {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  extension: string;
  modifiedAt: string;
}

// Mirrors FS_ERROR_TAG in src/main/ipc/file-handlers.ts. Renderer
// detects these by parsing error.message (IPC flattens Error → string).
const FS_ERROR_TAG_PERMISSION_DENIED = "FS_PERMISSION_DENIED";
const FS_ERROR_TAG_NOT_FOUND = "FS_NOT_FOUND";

type ListError =
  | { kind: "permission"; path: string }
  | { kind: "not-found"; path: string }
  | { kind: "other"; message: string };

const classifyListError = (err: unknown): ListError => {
  const msg = err instanceof Error ? err.message : String(err);
  // Electron wraps IPC errors as `Error invoking remote method '...': Error: [TAG] path`
  const permMatch = msg.match(
    new RegExp(`\\[${FS_ERROR_TAG_PERMISSION_DENIED}\\]\\s*(.*)`),
  );
  if (permMatch) return { kind: "permission", path: permMatch[1].trim() };
  const notFoundMatch = msg.match(
    new RegExp(`\\[${FS_ERROR_TAG_NOT_FOUND}\\]\\s*(.*)`),
  );
  if (notFoundMatch)
    return { kind: "not-found", path: notFoundMatch[1].trim() };
  return { kind: "other", message: msg };
};

interface SidebarProps {
  workspacePath: string;
  workspaceRef?: WorkspaceRef;
  /**
   * Live branch for local workspaces. Remote workspaces ignore this
   * (BranchSwitcher reads `workspaceRef.ref`). null = not a git repo
   * or detached HEAD → no chip rendered.
   */
  currentBranch?: string | null;
  onChangeDirectory: (path: string) => void;
  onCloseDirectory: () => void;
  onLocaleChange: (locale: Locales) => void;
  onSelectFile: (path: string) => void;
  /**
   * Called after a successful branch switch. Lets the parent update
   * the persisted WorkspaceRef so subsequent tasks operate against
   * the new branch. Receives the new branch name.
   */
  onBranchSwitched?: (newBranch: string) => void;
  /** True when the right-side branch-diff panel is currently visible.
   *  Used so the trigger pill can render an "active" state. */
  branchDiffOpen?: boolean;
  /** Toggle the right-side panel. Owned by App so the panel lives in
   *  the main flexbox row and can hold its own resize state. */
  onToggleBranchDiff?: () => void;
}

export const Sidebar = ({
  workspacePath,
  workspaceRef,
  currentBranch,
  onChangeDirectory: _onChangeDirectory,
  onCloseDirectory,
  onLocaleChange,
  onSelectFile,
  onBranchSwitched,
  branchDiffOpen,
  onToggleBranchDiff,
}: SidebarProps) => {
  const { LL } = useI18nContext();
  const [files, setFiles] = useState<FileInfo[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [skillsOpen, setSkillsOpen] = useState(false);
  // Surface the current branch's aggregate +/- counts on the trigger
  // pill. Cheap to keep open — the hook caches and uses the same IPC
  // path the panel does. `currentBranch` busts the cache on checkout.
  const { data: diffSummary } = useBranchDiff({
    path: workspacePath,
    currentBranch,
    invalidator: 0,
  });
  const [childrenMap, setChildrenMap] = useState<Record<string, FileInfo[]>>(
    {},
  );
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [selectedPath, setSelectedPath] = useState<string | undefined>();
  const [rootError, setRootError] = useState<ListError | null>(null);

  const handleSelect = useCallback(
    (path: string) => {
      setSelectedPath(path);
      // Only trigger file open for non-directory entries
      const isDir =
        files.some((f) => f.path === path && f.isDirectory) ||
        Object.values(childrenMap).some((children) =>
          children.some((f) => f.path === path && f.isDirectory),
        );
      if (!isDir) {
        onSelectFile(path);
      }
    },
    [files, childrenMap, onSelectFile],
  );

  useEffect(() => {
    const loadFiles = async () => {
      try {
        const entries = await window.filework.listDirectory(workspacePath);
        setFiles(entries);
        setRootError(null);
      } catch (err) {
        setFiles([]);
        setRootError(classifyListError(err));
      }
    };
    loadFiles();
  }, [workspacePath]);

  const handleExpandedChange = useCallback(
    async (newExpanded: Set<string>) => {
      setExpandedPaths(newExpanded);
      // Load children for newly expanded folders. A permission error on
      // a sub-folder is silently ignored (renders as empty folder) —
      // showing a banner per inaccessible sub-folder would be noisy.
      for (const path of newExpanded) {
        if (!childrenMap[path]) {
          try {
            const entries = await window.filework.listDirectory(path);
            setChildrenMap((prev) => ({ ...prev, [path]: entries }));
          } catch {
            setChildrenMap((prev) => ({ ...prev, [path]: [] }));
          }
        }
      }
    },
    [childrenMap],
  );

  const openDirectory = () => {
    window.filework.showInFinder(workspacePath);
  };

  const handleRefresh = useCallback(async () => {
    try {
      const entries = await window.filework.listDirectory(workspacePath);
      setFiles(entries);
      setRootError(null);
    } catch (err) {
      setFiles([]);
      setRootError(classifyListError(err));
      return;
    }
    // Reload children for currently expanded folders
    const newChildrenMap: Record<string, FileInfo[]> = {};
    for (const path of expandedPaths) {
      try {
        newChildrenMap[path] = await window.filework.listDirectory(path);
      } catch {
        newChildrenMap[path] = [];
      }
    }
    setChildrenMap(newChildrenMap);
  }, [workspacePath, expandedPaths]);

  const handleGrantAccess = useCallback(() => {
    window.filework.openFilesAndFoldersSettings();
  }, []);

  // Listen for programmatic settings open (e.g. from error actions)
  useEffect(() => {
    const handler = () => {
      setSettingsOpen(true);
    };
    window.addEventListener("filework:open-settings", handler);
    return () => window.removeEventListener("filework:open-settings", handler);
  }, []);

  const dirName = workspaceRef
    ? workspaceRefLabel(workspaceRef)
    : workspacePath.split("/").pop() || workspacePath;
  const HeaderIcon =
    workspaceRef?.kind === "github"
      ? Github
      : workspaceRef?.kind === "gitlab"
        ? Gitlab
        : FolderOpen;
  const headerTitle = (() => {
    if (!workspaceRef) return workspacePath;
    if (workspaceRef.kind === "local") return workspaceRef.path;
    if (workspaceRef.kind === "github") {
      return `${workspaceRef.owner}/${workspaceRef.repo}@${workspaceRef.ref} · ${workspacePath}`;
    }
    return `${workspaceRef.host}/${workspaceRef.namespace}/${workspaceRef.project}@${workspaceRef.ref} · ${workspacePath}`;
  })();

  const renderEntries = (entries: FileInfo[]) =>
    entries.map((file) =>
      file.isDirectory ? (
        <FileTreeFolder key={file.path} path={file.path} name={file.name}>
          {childrenMap[file.path]
            ? renderEntries(childrenMap[file.path])
            : null}
        </FileTreeFolder>
      ) : (
        <FileTreeFile key={file.path} path={file.path} name={file.name} />
      ),
    );

  if (collapsed) {
    return (
      <div className="w-12 h-full bg-muted/50 border-r border-border flex flex-col items-center pt-14 gap-2">
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          className="p-2 rounded-md hover:bg-accent transition-colors"
          title={LL.sidebar_collapse()}
        >
          <ChevronRight className="w-4 h-4 text-muted-foreground" />
        </button>
      </div>
    );
  }

  return (
    <>
      <aside className="w-64 h-full bg-muted/30 border-r border-border flex flex-col pt-12">
        {/* Workspace header */}
        <div className="titlebar-no-drag flex flex-col px-3 py-2 border-b border-border gap-1">
          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={openDirectory}
              className="flex items-center gap-2 text-sm font-medium text-foreground hover:text-primary transition-colors truncate flex-1 min-w-0"
              title={headerTitle}
            >
              <HeaderIcon className="w-4 h-4 text-file-folder shrink-0" />
              <span className="truncate">{dirName}</span>
            </button>
            <div className="flex items-center shrink-0 ml-1">
              <button
                type="button"
                onClick={handleRefresh}
                className="p-1 rounded hover:bg-accent transition-colors"
                title={LL.sidebar_refresh()}
              >
                <RefreshCw className="w-3.5 h-3.5 text-muted-foreground" />
              </button>
              <button
                type="button"
                onClick={onCloseDirectory}
                className="p-1 rounded hover:bg-accent transition-colors"
                title={LL.sidebar_closeDir()}
              >
                <X className="w-3.5 h-3.5 text-muted-foreground" />
              </button>
            </div>
          </div>
          {workspaceRef &&
            (() => {
              const branchForChip =
                workspaceRef.kind === "local"
                  ? (currentBranch ?? null)
                  : workspaceRef.ref;
              if (branchForChip === null) return null;
              const kindBadge =
                workspaceRef.kind === "local"
                  ? "Local"
                  : workspaceRef.kind === "github"
                    ? "GitHub"
                    : "GitLab";
              const hasDiff =
                diffSummary &&
                !diffSummary.notAvailable &&
                (diffSummary.totalAdded > 0 || diffSummary.totalRemoved > 0);
              const diffButtonVisible =
                workspaceRef.kind !== "local" ||
                (diffSummary !== null &&
                  diffSummary.notAvailable !== "not-git");
              return (
                <div className="flex items-center gap-1.5 pl-6">
                  <BranchSwitcher
                    workspaceRef={workspaceRef}
                    currentBranch={branchForChip}
                    onSwitched={async (newBranch) => {
                      onBranchSwitched?.(newBranch);
                      await handleRefresh();
                    }}
                  />
                  {diffButtonVisible && onToggleBranchDiff && (
                    <button
                      type="button"
                      onClick={onToggleBranchDiff}
                      title={LL.branch_diff_open()}
                      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] hover:bg-accent hover:text-foreground ${
                        branchDiffOpen
                          ? "border-primary/50 bg-accent/50 text-foreground"
                          : "border-border/60 text-muted-foreground"
                      }`}
                    >
                      <GitCompareArrows className="size-3" />
                      {hasDiff && diffSummary && (
                        <span className="font-mono">
                          <span className="text-emerald-500">
                            +{diffSummary.totalAdded}
                          </span>{" "}
                          <span className="text-red-400">
                            -{diffSummary.totalRemoved}
                          </span>
                        </span>
                      )}
                    </button>
                  )}
                  <span className="text-[10px] uppercase tracking-wide text-muted-foreground/70 px-1.5 py-0.5 rounded bg-muted">
                    {kindBadge}
                  </span>
                </div>
              );
            })()}
        </div>

        {/* Error banner (permission / not-found / other) */}
        {rootError && (
          <div
            className={
              rootError.kind === "permission"
                ? "mx-2 mt-2 rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-200"
                : "mx-2 mt-2 rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
            }
          >
            <div className="flex items-start gap-2">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="font-medium">
                  {rootError.kind === "permission"
                    ? LL.sidebar_permissionDenied()
                    : rootError.kind === "not-found"
                      ? LL.sidebar_folderNotFound()
                      : rootError.message}
                </div>
                {rootError.kind === "permission" && (
                  <div className="mt-1 leading-snug opacity-90">
                    {LL.sidebar_permissionDeniedHint()}
                  </div>
                )}
                <div className="mt-2 flex flex-wrap gap-2">
                  {rootError.kind === "permission" && (
                    <button
                      type="button"
                      onClick={handleGrantAccess}
                      className="px-2 py-1 rounded bg-amber-500/20 hover:bg-amber-500/30 transition-colors font-medium"
                    >
                      {LL.sidebar_openSystemSettings()}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={handleRefresh}
                    className="px-2 py-1 rounded bg-muted hover:bg-accent transition-colors font-medium"
                  >
                    {LL.sidebar_retry()}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* File tree */}
        <div className="flex-1 overflow-y-auto px-1 py-2">
          <FileTree
            expanded={expandedPaths}
            onExpandedChange={handleExpandedChange}
            selectedPath={selectedPath}
            onSelect={handleSelect}
          >
            {renderEntries(files)}
          </FileTree>
        </div>

        {/* Bottom actions */}
        <div className="titlebar-no-drag border-t border-border px-3 py-2 flex items-center gap-3">
          <button
            type="button"
            onClick={() => setSkillsOpen(true)}
            className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            <Blocks className="w-4 h-4" />
            {LL.sidebar_skills()}
          </button>
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors ml-auto"
          >
            <Settings className="w-4 h-4" />
            {LL.sidebar_settings()}
          </button>
        </div>
      </aside>

      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onLocaleChange={onLocaleChange}
      />

      <SkillsModal open={skillsOpen} onClose={() => setSkillsOpen(false)} />
    </>
  );
};
