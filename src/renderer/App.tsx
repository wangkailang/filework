import { useCallback, useEffect, useRef, useState } from "react";
import { Toaster } from "sonner";
import { BrowserRouterProvider } from "./components/browser/context";
import { ChatPanel } from "./components/chat/ChatPanel";
import { ChatSessionProvider } from "./components/chat/ChatSessionProvider";
import { CommandPalette } from "./components/command/CommandPalette";
import { ContextDock, type DockTab } from "./components/dock/ContextDock";
import { DockMenu } from "./components/dock/DockMenu";
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

// 启动时同步加载所有语言包
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
  /** 文件树 / 沙箱使用的磁盘路径(github/gitlab 为克隆目录)。 */
  localPath: string;
  /**
   * 本地工作区的当前分支。null = 游离 HEAD 或非 git 仓库;
   * undefined = 尚未探测。远程工作区保持其为 undefined,
   * 转而从 `ref.ref` 读取分支。
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
  // 每当破坏性工具执行完成时自增;branch-diff hook 以此作为失效信号,
  // 使停靠区的 Diff 标签能反映写入后的实际状态,而无需等待 30 秒 TTL。
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
  const [automationInitialView, setAutomationInitialView] = useState<
    "tasks" | "triage"
  >("tasks");
  const [automationViewRevision, setAutomationViewRevision] = useState(0);
  // 钻入面板:当前在 dock 查看的子 agent(批次 + 子任务)。
  const [dockSubagent, setDockSubagent] = useState<{
    batchId: string;
    childTaskId: string;
  } | null>(null);

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
  const openSubagentInDock = useCallback(
    (sel: { batchId: string; childTaskId: string }) => {
      setDockSubagent(sel);
      setDockTab("subagent");
      setDockOpen(true);
    },
    [],
  );
  const openInBrowserPanel = useCallback((u: string) => {
    // 网页面板对所有工作区可用(含非 git):内置 webview 与 git 无依赖,
    // 既承载聊天里的链接,也承载本地 HTML(local-file://)的活页面预览。
    setBrowserUrl(u);
    setDockTab("web");
    setDockOpen(true);
  }, []);
  const resetDock = useCallback(() => {
    setDockOpen(false);
    setDockFilePath(null);
    setBrowserUrl(null);
    setDockSubagent(null);
  }, []);

  useEffect(() => {
    const onResize = () => setWinWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // 设置入口从侧栏迁到顶栏齿轮 / 错误恢复按钮,统一通过事件打开。
  useEffect(() => {
    const handler = () => setSettingsOpen(true);
    window.addEventListener("filework:open-settings", handler);
    return () => window.removeEventListener("filework:open-settings", handler);
  }, []);

  // 回合交付物卡片点击文件 → 在 ContextDock 预览(同 open-settings 的事件模式,
  // 避免把 openFileInDock 一路透传到 ChatPanel)。
  useEffect(() => {
    const handler = (e: Event) => {
      const path = (e as CustomEvent<{ path?: string }>).detail?.path;
      if (path) openFileInDock(path);
    };
    window.addEventListener("filework:open-file", handler);
    return () => window.removeEventListener("filework:open-file", handler);
  }, [openFileInDock]);

  // 文件预览里点「在浏览器中预览」(本地 HTML)→ 在网页面板渲染为活页面。
  useEffect(() => {
    const handler = (e: Event) => {
      const url = (e as CustomEvent<{ url?: string }>).detail?.url;
      if (url) openInBrowserPanel(url);
    };
    window.addEventListener("filework:open-web", handler);
    return () => window.removeEventListener("filework:open-web", handler);
  }, [openInBrowserPanel]);

  // 子任务卡点击某行 → 在 ContextDock 的 subagent tab 钻入查看其执行过程。
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (
        e as CustomEvent<{ batchId?: string; childTaskId?: string }>
      ).detail;
      if (detail?.batchId && detail.childTaskId) {
        openSubagentInDock({
          batchId: detail.batchId,
          childTaskId: detail.childTaskId,
        });
      }
    };
    window.addEventListener("filework:open-subagent", handler);
    return () => window.removeEventListener("filework:open-subagent", handler);
  }, [openSubagentInDock]);

  useEffect(() => {
    return window.filework.automations.onOpenTriage(() => {
      setAutomationInitialView("triage");
      setAutomationViewRevision((revision) => revision + 1);
      setDockTab("automations");
      setDockOpen(true);
    });
  }, []);

  // 全局快捷键:⇧⌘ + 首字母 切换右侧面板(与 DockMenu 的提示一致)。
  // 非 git 项目无 diff(网页面板恒可用);无选中子 agent 时跳过 subagent。
  useEffect(() => {
    const map: Record<string, DockTab> = {
      p: "preview",
      f: "search",
      t: "trash",
      m: "automations",
      d: "diff",
      w: "web",
      a: "subagent",
    };
    const handler = (e: KeyboardEvent) => {
      if (!e.metaKey || !e.shiftKey) return;
      const tab = map[e.key.toLowerCase()];
      if (!tab) return;
      if (tab === "diff" && !workspaceRef.current?.isGitRepo) return;
      if (tab === "subagent" && !dockSubagent) return;
      e.preventDefault();
      if (dockOpen && dockTab === tab) {
        setDockOpen(false);
      } else {
        setDockTab(tab);
        setDockOpen(true);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [dockOpen, dockTab, dockSubagent]);

  const resolveWorkspace = useCallback(
    async (ref: WorkspaceRef): Promise<ResolvedWorkspace> => {
      if (ref.kind === "local") {
        // 防御那些把远程工作区 URI 包裹进伪造的 "local" ref 中的损坏
        // recent_workspaces 记录。将其视为错误,而非把该 URI 交给
        // fs:listDirectory。
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

  // HEAD-watcher 同步:每当 `.git/HEAD` 变化时(聊天驱动的 `git checkout`、
  // 外部终端、BranchSwitcher 自身等),主进程会广播 `workspace:branch-changed`。
  // 我们据此修补 `workspace.ref.ref`,使 BranchSwitcher 标签及下游消费者
  // 与磁盘实际状态保持同步。以 `cloneDir`(== `workspace.localPath`)匹配,
  // 因为 `workspaceRefId` 内嵌了 ref,切换时会变化。
  // 通过 ref 读取,使监听器只挂载一次,且 addRecentWorkspace 不在 setState
  // 更新函数内运行(否则 StrictMode 会触发两次)。
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

  // 启动时:恢复最近一次的工作区
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

  // 面板开关:已在该标签且开着 → 关;否则切到该标签并打开 Dock。
  // 顶部 DockMenu、快捷键、LeftRail 的 Diff 按钮共用此逻辑。
  const openDockTab = (tab: DockTab) => {
    if (dockOpen && dockTab === tab) {
      setDockOpen(false);
    } else {
      setDockTab(tab);
      setDockOpen(true);
    }
  };
  const toggleDiff = () => openDockTab("diff");
  const openAutomations = () => {
    setAutomationInitialView("tasks");
    setAutomationViewRevision((revision) => revision + 1);
    setDockTab("automations");
    setDockOpen(true);
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
                  automationsOpen={dockOpen && dockTab === "automations"}
                  onOpenAutomations={openAutomations}
                  onOpenSettings={() => setSettingsOpen(true)}
                />
                <main className="relative flex min-w-0 flex-1 overflow-hidden">
                  <div className="relative min-w-0 flex-1 overflow-hidden">
                    <ChatPanel
                      workspacePath={workspace.localPath}
                      railCollapsed={railCollapsed}
                    />
                    {/* 顶部右上角面板菜单:垂直居中嵌入 telemetry 状态条右端(h-[34px]),
                        与状态条的 pr-16 留白配合,避免压住右侧读数文本。 */}
                    <div className="titlebar-no-drag absolute top-0 right-2 z-30 flex h-[34px] items-center">
                      <DockMenu
                        activeTab={dockTab}
                        dockOpen={dockOpen}
                        isGitRepo={workspace.isGitRepo}
                        hasSubagent={dockSubagent != null}
                        onSelect={openDockTab}
                      />
                    </div>
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
                      railWidth={railWidth}
                      railCollapsed={railCollapsed}
                      filePath={dockFilePath}
                      url={browserUrl}
                      subagentSel={dockSubagent}
                      onSelectSubagentChild={(childTaskId) =>
                        setDockSubagent((s) => (s ? { ...s, childTaskId } : s))
                      }
                      workspaceRoot={workspace.localPath}
                      currentBranch={workspace.currentBranch}
                      diffInvalidator={diffInvalidator}
                      isGitRepo={workspace.isGitRepo}
                      automationInitialView={automationInitialView}
                      automationViewRevision={automationViewRevision}
                    />
                  )}
                </main>
              </div>
              <CommandPalette
                isGitRepo={workspace.isGitRepo}
                hasSubagent={dockSubagent != null}
                onOpenDockTab={openDockTab}
                onOpenSettings={() => setSettingsOpen(true)}
                onSwitchWorkspace={() => setWorkspace(null)}
              />
            </BrowserRouterProvider>
            <SettingsModal
              open={settingsOpen}
              onClose={() => setSettingsOpen(false)}
              onLocaleChange={setLocale}
            />
          </ChatSessionProvider>
        </div>
      )}
      <Toaster
        position="bottom-right"
        toastOptions={{ className: "font-mono" }}
      />
    </TypesafeI18n>
  );
};
