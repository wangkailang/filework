import { useCallback, useEffect, useRef, useState } from "react";
import { BranchDiffPanel } from "./components/branch-diff/BranchDiffPanel";
import { BrowserPanel } from "./components/browser/BrowserPanel";
import { BrowserRouterProvider } from "./components/browser/context";
import { ChatPanel } from "./components/chat/ChatPanel";
import { ChatSessionProvider } from "./components/chat/ChatSessionProvider";
import { FilePreviewPanel } from "./components/file-preview/FilePreviewPanel";
import {
  Sidebar,
  SidebarExpandFloatingButton,
} from "./components/layout/Sidebar";
import { GitHubConnectModal } from "./components/onboarding/GitHubConnectModal";
import { GitLabConnectModal } from "./components/onboarding/GitLabConnectModal";
import { WelcomeScreen } from "./components/onboarding/WelcomeScreen";
import TypesafeI18n from "./i18n/i18n-react";
import type { Locales } from "./i18n/i18n-types";
import { loadAllLocales } from "./i18n/i18n-util.sync";
import {
  decodeRef,
  encodeRef,
  type WorkspaceRef,
  workspaceRefId,
  workspaceRefLabel,
} from "./types/workspace-ref";

// Load all locales synchronously at startup
loadAllLocales();

const getInitialLocale = (): Locales => {
  const saved = localStorage.getItem("filework-locale") as Locales | null;
  if (saved) return saved;
  const lang = navigator.language;
  if (lang.startsWith("zh")) return "zh-CN";
  if (lang.startsWith("ja")) return "ja";
  return "en";
};

const SIDEBAR_MIN_WIDTH = 180;
const SIDEBAR_MAX_WIDTH = 480;
const SIDEBAR_DEFAULT_WIDTH = 256;

const clampSidebarWidth = (n: number): number =>
  Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, n));

const getInitialSidebarWidth = (): number => {
  const saved = localStorage.getItem("filework-sidebar-width");
  if (!saved) return SIDEBAR_DEFAULT_WIDTH;
  const n = Number.parseInt(saved, 10);
  return Number.isFinite(n) ? clampSidebarWidth(n) : SIDEBAR_DEFAULT_WIDTH;
};

const getInitialSidebarCollapsed = (): boolean =>
  localStorage.getItem("filework-sidebar-collapsed") === "1";

interface ResolvedWorkspace {
  ref: WorkspaceRef;
  /** On-disk path the file tree / sandbox uses (clone dir for github/gitlab). */
  localPath: string;
  /**
   * Current branch for local workspaces. null = detached HEAD or not a
   * git repo; undefined = not yet probed. Remote workspaces leave this
   * undefined and read the branch from `ref.ref` instead.
   */
  currentBranch?: string | null;
}

const recentKeyFor = (ref: WorkspaceRef): string =>
  ref.kind === "local" ? ref.path : workspaceRefId(ref);

export const App = () => {
  const [workspace, setWorkspace] = useState<ResolvedWorkspace | null>(null);
  const [locale, setLocale] = useState<Locales>(getInitialLocale);
  const [isRestoring, setIsRestoring] = useState(true);
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [githubModalOpen, setGithubModalOpen] = useState(false);
  const [gitlabModalOpen, setGitlabModalOpen] = useState(false);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [branchDiffOpen, setBranchDiffOpen] = useState(false);
  // Bumped whenever a destructive tool finishes; the branch-diff hook
  // uses this as its invalidator so the sidebar pill and panel reflect
  // post-write reality without waiting for the 30 s TTL.
  const [diffInvalidator, setDiffInvalidator] = useState(0);
  const [sidebarWidth, setSidebarWidth] = useState<number>(
    getInitialSidebarWidth,
  );
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(
    getInitialSidebarCollapsed,
  );
  const [browserUrl, setBrowserUrl] = useState<string | null>(null);
  const handleCommitSidebarWidth = useCallback((w: number) => {
    localStorage.setItem("filework-sidebar-width", String(w));
  }, []);
  const handleToggleSidebarCollapsed = useCallback(() => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem("filework-sidebar-collapsed", next ? "1" : "0");
      return next;
    });
  }, []);

  const resolveWorkspace = useCallback(
    async (ref: WorkspaceRef): Promise<ResolvedWorkspace> => {
      if (ref.kind === "local") {
        // Defense against corrupted recent_workspaces rows that wrapped a
        // remote workspace URI inside a fake "local" ref. Treat as an error
        // rather than handing the URI to fs:listDirectory.
        if (ref.path.startsWith("gitlab:") || ref.path.startsWith("github:")) {
          throw new Error(
            "Recent workspace metadata is corrupted; please reconnect the remote repo.",
          );
        }
        const probe = await window.filework.local.probeGit({ path: ref.path });
        return {
          ref,
          localPath: ref.path,
          currentBranch: probe.isGitRepo ? probe.currentBranch : null,
        };
      }
      if (ref.kind === "github") {
        const { root } = await window.filework.github.cloneRepo({
          credentialId: ref.credentialId,
          owner: ref.owner,
          repo: ref.repo,
          ref: ref.ref,
        });
        return { ref, localPath: root };
      }
      const { root } = await window.filework.gitlab.cloneRepo({
        credentialId: ref.credentialId,
        host: ref.host,
        namespace: ref.namespace,
        project: ref.project,
        ref: ref.ref,
      });
      return { ref, localPath: root };
    },
    [],
  );

  // HEAD-watcher sync: main process broadcasts `workspace:branch-changed`
  // whenever `.git/HEAD` changes (chat-driven `git checkout`, external
  // terminal, BranchSwitcher itself, etc.). We patch `workspace.ref.ref`
  // so the BranchSwitcher chip and downstream consumers stay in sync
  // with on-disk reality. Match by `cloneDir` (== `workspace.localPath`)
  // because `workspaceRefId` embeds the ref and would change on switch.
  // Read via a ref so the listener is mounted once and addRecentWorkspace
  // doesn't run inside a setState updater (StrictMode would double-fire it).
  const workspaceRef = useRef<ResolvedWorkspace | null>(workspace);
  useEffect(() => {
    workspaceRef.current = workspace;
  }, [workspace]);

  // Bump the branch-diff invalidator whenever a destructive tool
  // finishes — refreshes both the sidebar +/- pill and the open panel
  // without waiting for the cache TTL.
  useEffect(() => {
    const DESTRUCTIVE = new Set([
      "writeFile",
      "moveFile",
      "deleteFile",
      "createDirectory",
      "runCommand",
    ]);
    const off = window.filework.onStreamToolResult(({ toolName }) => {
      if (DESTRUCTIVE.has(toolName)) {
        setDiffInvalidator((n) => n + 1);
      }
    });
    return () => {
      off();
    };
  }, []);
  useEffect(() => {
    const unsubscribe = window.filework.onWorkspaceBranchChanged(
      ({ cloneDir, branch }) => {
        const curr = workspaceRef.current;
        if (!curr) return;
        if (cloneDir !== curr.localPath) return;
        if (curr.ref.kind === "local") {
          if (curr.currentBranch === branch) return;
          setWorkspace({ ...curr, currentBranch: branch });
          return;
        }
        if (curr.ref.ref === branch) return;
        const updatedRef: WorkspaceRef = { ...curr.ref, ref: branch };
        setWorkspace({ ...curr, ref: updatedRef });
        window.filework.addRecentWorkspace(
          recentKeyFor(updatedRef),
          workspaceRefLabel(updatedRef),
          { kind: updatedRef.kind, metadata: encodeRef(updatedRef) },
        );
      },
    );
    return () => {
      unsubscribe();
    };
  }, []);

  // On launch: restore the most recent workspace
  useEffect(() => {
    const restore = async () => {
      try {
        const recent = await window.filework.getRecentWorkspaces();
        if (recent.length === 0) return;
        const top = recent[0];
        const ref: WorkspaceRef = decodeRef(top.metadata) ?? {
          kind: "local",
          path: top.path,
        };
        try {
          const resolved = await resolveWorkspace(ref);
          setWorkspace(resolved);
        } catch (err) {
          console.warn("[App] Failed to restore workspace:", err);
        }
      } finally {
        setIsRestoring(false);
      }
    };
    restore();
  }, [resolveWorkspace]);

  const recordRecent = (ref: WorkspaceRef, label: string) => {
    window.filework.addRecentWorkspace(recentKeyFor(ref), label, {
      kind: ref.kind,
      metadata: encodeRef(ref),
    });
  };

  const handleSelectLocal = async (path: string) => {
    if (path.startsWith("gitlab:") || path.startsWith("github:")) {
      setResolveError(
        "Recent workspace metadata is corrupted; please reconnect the remote repo.",
      );
      return;
    }
    const ref: WorkspaceRef = { kind: "local", path };
    setSelectedFilePath(null);
    try {
      const resolved = await resolveWorkspace(ref);
      setWorkspace(resolved);
      recordRecent(ref, workspaceRefLabel(ref));
    } catch (err) {
      setResolveError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleSelectRemote = async (ref: WorkspaceRef) => {
    setGithubModalOpen(false);
    setGitlabModalOpen(false);
    setResolveError(null);
    setIsRestoring(true);
    try {
      const resolved = await resolveWorkspace(ref);
      setSelectedFilePath(null);
      setWorkspace(resolved);
      recordRecent(ref, workspaceRefLabel(ref));
    } catch (err) {
      setResolveError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsRestoring(false);
    }
  };

  if (isRestoring) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-background">
        <div className="titlebar-drag fixed top-0 left-0 right-0 h-12" />
      </div>
    );
  }

  const workspaceRefJson = workspace ? encodeRef(workspace.ref) : undefined;

  return (
    <TypesafeI18n key={locale} locale={locale}>
      {!workspace ? (
        <>
          <WelcomeScreen
            onSelectDirectory={handleSelectLocal}
            onSelectGithub={() => setGithubModalOpen(true)}
            onSelectGitlab={() => setGitlabModalOpen(true)}
            onSelectRecentRef={handleSelectRemote}
            errorMessage={resolveError}
          />
          {githubModalOpen && (
            <GitHubConnectModal
              onCancel={() => setGithubModalOpen(false)}
              onConfirm={handleSelectRemote}
            />
          )}
          {gitlabModalOpen && (
            <GitLabConnectModal
              onCancel={() => setGitlabModalOpen(false)}
              onConfirm={handleSelectRemote}
            />
          )}
        </>
      ) : (
        <div className="flex h-screen w-screen overflow-hidden">
          <div className="titlebar-drag fixed top-0 left-0 right-0 h-12 z-50" />
          {sidebarCollapsed && (
            <SidebarExpandFloatingButton
              onClick={handleToggleSidebarCollapsed}
            />
          )}
          <Sidebar
            workspacePath={workspace.localPath}
            workspaceRef={workspace.ref}
            currentBranch={workspace.currentBranch}
            onChangeDirectory={handleSelectLocal}
            onCloseDirectory={() => setWorkspace(null)}
            onLocaleChange={setLocale}
            onSelectFile={setSelectedFilePath}
            branchDiffOpen={branchDiffOpen}
            diffInvalidator={diffInvalidator}
            onToggleBranchDiff={() => setBranchDiffOpen((v) => !v)}
            width={sidebarWidth}
            collapsed={sidebarCollapsed}
            onWidthChange={setSidebarWidth}
            onCommitWidth={handleCommitSidebarWidth}
            onToggleCollapsed={handleToggleSidebarCollapsed}
            onBranchSwitched={(branch) => {
              if (workspace.ref.kind === "local") {
                // Local: just patch the live chip state. No persist —
                // local refs don't carry a branch, and next launch
                // re-probes from disk.
                setWorkspace({ ...workspace, currentBranch: branch });
                return;
              }
              // Remote: persist the new ref so subsequent agent tasks
              // treat it as the base / PR target.
              const updatedRef: WorkspaceRef = {
                ...workspace.ref,
                ref: branch,
              };
              setWorkspace({ ...workspace, ref: updatedRef });
              recordRecent(updatedRef, workspaceRefLabel(updatedRef));
            }}
          />
          <ChatSessionProvider
            key={workspace.localPath}
            workspacePath={workspace.localPath}
            workspaceRefJson={workspaceRefJson}
          >
            <BrowserRouterProvider openInPanel={setBrowserUrl}>
              <main className="flex-1 flex pt-12 overflow-hidden">
                {selectedFilePath && (
                  <div className="w-7/10 border-r border-border overflow-hidden">
                    <FilePreviewPanel
                      filePath={selectedFilePath}
                      onClose={() => setSelectedFilePath(null)}
                    />
                  </div>
                )}
                <div
                  className={
                    selectedFilePath
                      ? "w-3/10 overflow-hidden"
                      : "flex-1 overflow-hidden"
                  }
                >
                  <ChatPanel workspacePath={workspace.localPath} />
                </div>
                {branchDiffOpen && (
                  <BranchDiffPanel
                    workspaceRoot={workspace.localPath}
                    currentBranch={workspace.currentBranch}
                    invalidator={diffInvalidator}
                    onClose={() => setBranchDiffOpen(false)}
                  />
                )}
                {browserUrl && (
                  <BrowserPanel
                    url={browserUrl}
                    onClose={() => setBrowserUrl(null)}
                  />
                )}
              </main>
            </BrowserRouterProvider>
          </ChatSessionProvider>
        </div>
      )}
    </TypesafeI18n>
  );
};
