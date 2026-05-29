import { useCallback, useEffect, useRef, useState } from "react";
import { BrowserRouterProvider } from "./components/browser/context";
import { ChatPanel } from "./components/chat/ChatPanel";
import { ChatSessionProvider } from "./components/chat/ChatSessionProvider";
import { ContextDock, type DockTab } from "./components/dock/ContextDock";
import {
  LeftRail,
  RailExpandButton,
  type RailTab,
} from "./components/layout/LeftRail";
import {
  clampDockWidth,
  clampRailWidth,
  DOCK_DEFAULT_WIDTH,
  RAIL_DEFAULT_WIDTH,
  resolveDockMode,
} from "./components/layout/layout-geometry";
import { SettingsModal } from "./components/layout/SettingsModal";
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

// 左栏宽度 / 折叠:优先读新键 filework-rail-*,回落旧 filework-sidebar-*
// (一次性迁移,老用户偏好不丢)。
const getInitialRailWidth = (): number => {
  const saved =
    localStorage.getItem("filework-rail-width") ??
    localStorage.getItem("filework-sidebar-width");
  if (!saved) return RAIL_DEFAULT_WIDTH;
  return clampRailWidth(Number.parseInt(saved, 10));
};

const getInitialRailCollapsed = (): boolean =>
  (localStorage.getItem("filework-rail-collapsed") ??
    localStorage.getItem("filework-sidebar-collapsed")) === "1";

const getInitialDockWidth = (): number => {
  const saved = localStorage.getItem("filework-dock-width");
  if (!saved) return DOCK_DEFAULT_WIDTH;
  return clampDockWidth(Number.parseInt(saved, 10));
};

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
  /**
   * 是否 git 仓库:本地由 probeGit 探测,远程(github/gitlab)恒为 true。
   * 非 git 项目隐藏「差异 / 网页」入口(见 ContextDock 与 openInBrowserPanel)。
   */
  isGitRepo: boolean;
}

const recentKeyFor = (ref: WorkspaceRef): string =>
  ref.kind === "local" ? ref.path : workspaceRefId(ref);

export const App = () => {
  const [workspace, setWorkspace] = useState<ResolvedWorkspace | null>(null);
  const [locale, setLocale] = useState<Locales>(getInitialLocale);
  const [isRestoring, setIsRestoring] = useState(true);
  const [githubModalOpen, setGithubModalOpen] = useState(false);
  const [gitlabModalOpen, setGitlabModalOpen] = useState(false);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Bumped whenever a destructive tool finishes; the branch-diff hook
  // uses this as its invalidator so the dock Diff tab reflects post-write
  // reality without waiting for the 30 s TTL.
  const [diffInvalidator, setDiffInvalidator] = useState(0);

  // 左栏
  const [railTab, setRailTab] = useState<RailTab>("chats");
  const [railWidth, setRailWidth] = useState<number>(getInitialRailWidth);
  const [railCollapsed, setRailCollapsed] = useState<boolean>(
    getInitialRailCollapsed,
  );

  // 右侧 ContextDock(统一停靠:预览 / Diff / Web)
  const [dockOpen, setDockOpen] = useState(false);
  const [dockTab, setDockTab] = useState<DockTab>("preview");
  const [dockFilePath, setDockFilePath] = useState<string | null>(null);
  const [dockWidth, setDockWidth] = useState<number>(getInitialDockWidth);
  const [browserUrl, setBrowserUrl] = useState<string | null>(null);

  // 窗口宽度:决定 Dock 用分栏还是浮层(避免对话被压到不可读)。
  const [winWidth, setWinWidth] = useState<number>(() => window.innerWidth);

  const commitRailWidth = useCallback((w: number) => {
    localStorage.setItem("filework-rail-width", String(w));
  }, []);
  const toggleRailCollapsed = useCallback(() => {
    setRailCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem("filework-rail-collapsed", next ? "1" : "0");
      return next;
    });
  }, []);
  const commitDockWidth = useCallback((w: number) => {
    localStorage.setItem("filework-dock-width", String(w));
  }, []);
  const openFileInDock = useCallback((path: string) => {
    setDockFilePath(path);
    setDockTab("preview");
    setDockOpen(true);
  }, []);
  const openInBrowserPanel = useCallback((u: string) => {
    // 非 git 项目不提供内置网页面板,链接交给系统浏览器打开(workspaceRef 见下方,
    // 闭包在调用时才读 .current,此时已初始化)。
    if (!workspaceRef.current?.isGitRepo) {
      void window.filework.openExternal(u).catch(() => {});
      return;
    }
    setBrowserUrl(u);
    setDockTab("web");
    setDockOpen(true);
  }, []);
  const resetDock = useCallback(() => {
    setDockOpen(false);
    setDockFilePath(null);
    setBrowserUrl(null);
  }, []);

  useEffect(() => {
    const onResize = () => setWinWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Settings 入口从侧栏迁到顶栏齿轮 / 错误恢复按钮,统一通过事件打开。
  useEffect(() => {
    const handler = () => setSettingsOpen(true);
    window.addEventListener("filework:open-settings", handler);
    return () => window.removeEventListener("filework:open-settings", handler);
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
          isGitRepo: probe.isGitRepo,
        };
      }
      if (ref.kind === "github") {
        const { root } = await window.filework.github.cloneRepo({
          credentialId: ref.credentialId,
          owner: ref.owner,
          repo: ref.repo,
          ref: ref.ref,
        });
        return { ref, localPath: root, isGitRepo: true };
      }
      const { root } = await window.filework.gitlab.cloneRepo({
        credentialId: ref.credentialId,
        host: ref.host,
        namespace: ref.namespace,
        project: ref.project,
        ref: ref.ref,
      });
      return { ref, localPath: root, isGitRepo: true };
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
    resetDock();
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
      resetDock();
      setWorkspace(resolved);
      recordRecent(ref, workspaceRefLabel(ref));
    } catch (err) {
      setResolveError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsRestoring(false);
    }
  };

  // 分支切换后更新持久化的 WorkspaceRef,使后续 agent 任务以新分支为基准。
  const handleBranchSwitched = (branch: string) => {
    if (!workspace) return;
    if (workspace.ref.kind === "local") {
      // 本地:仅更新实时 chip 状态,不持久化(本地 ref 不带分支,下次启动
      // 会从磁盘重新探测)。
      setWorkspace({ ...workspace, currentBranch: branch });
      return;
    }
    const updatedRef: WorkspaceRef = { ...workspace.ref, ref: branch };
    setWorkspace({ ...workspace, ref: updatedRef });
    recordRecent(updatedRef, workspaceRefLabel(updatedRef));
  };

  // Diff 开关:已在 Diff 标签且开着 → 关;否则切到 Diff 并打开 Dock。
  const toggleDiff = () => {
    if (dockOpen && dockTab === "diff") {
      setDockOpen(false);
    } else {
      setDockTab("diff");
      setDockOpen(true);
    }
  };

  if (isRestoring) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-background">
        <div className="titlebar-drag fixed top-0 right-0 left-0 h-12" />
      </div>
    );
  }

  const workspaceRefJson = workspace ? encodeRef(workspace.ref) : undefined;
  const branchForChip =
    workspace == null
      ? null
      : workspace.ref.kind === "local"
        ? (workspace.currentBranch ?? null)
        : workspace.ref.ref;
  const dockMode = resolveDockMode({
    windowWidth: winWidth,
    railWidth,
    railCollapsed,
    dockWidth,
  });

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
        <div className="flex h-screen w-screen flex-col overflow-hidden">
          {/* 极简透明拖拽条:macOS 无边框窗口靠它拖动 + 让开红绿灯。非工具栏。 */}
          <div className="titlebar-drag h-7 shrink-0" />
          <ChatSessionProvider
            key={workspace.localPath}
            workspacePath={workspace.localPath}
            workspaceRefJson={workspaceRefJson}
          >
            <BrowserRouterProvider openInPanel={openInBrowserPanel}>
              <div className="relative flex min-h-0 flex-1 overflow-hidden">
                {railCollapsed && (
                  <RailExpandButton onClick={toggleRailCollapsed} />
                )}
                <LeftRail
                  workspacePath={workspace.localPath}
                  workspaceRef={workspace.ref}
                  currentBranch={workspace.currentBranch}
                  isGitRepo={workspace.isGitRepo}
                  branchForChip={branchForChip}
                  diffInvalidator={diffInvalidator}
                  diffOpen={dockOpen && dockTab === "diff"}
                  railTab={railTab}
                  onRailTabChange={setRailTab}
                  onSelectFile={openFileInDock}
                  width={railWidth}
                  collapsed={railCollapsed}
                  onWidthChange={setRailWidth}
                  onCommitWidth={commitRailWidth}
                  onToggleCollapsed={toggleRailCollapsed}
                  onToggleDiff={toggleDiff}
                  onBranchSwitched={handleBranchSwitched}
                  onCloseWorkspace={() => setWorkspace(null)}
                  onOpenSettings={() => setSettingsOpen(true)}
                />
                <main className="relative flex min-w-0 flex-1 overflow-hidden">
                  <div className="min-w-0 flex-1 overflow-hidden">
                    <ChatPanel workspacePath={workspace.localPath} />
                  </div>
                  {dockOpen && (
                    <ContextDock
                      mode={dockMode}
                      width={dockWidth}
                      activeTab={dockTab}
                      onTabChange={setDockTab}
                      onClose={() => setDockOpen(false)}
                      onWidthChange={setDockWidth}
                      onCommitWidth={commitDockWidth}
                      filePath={dockFilePath}
                      url={browserUrl}
                      workspaceRoot={workspace.localPath}
                      currentBranch={workspace.currentBranch}
                      diffInvalidator={diffInvalidator}
                      isGitRepo={workspace.isGitRepo}
                    />
                  )}
                </main>
              </div>
            </BrowserRouterProvider>
          </ChatSessionProvider>
          <SettingsModal
            open={settingsOpen}
            onClose={() => setSettingsOpen(false)}
            onLocaleChange={setLocale}
          />
        </div>
      )}
    </TypesafeI18n>
  );
};
