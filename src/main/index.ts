import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { config } from "dotenv";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  nativeImage,
  protocol,
  session,
  shell,
} from "electron";

// 从应用根目录加载 .env(必须在任何 env 访问之前执行)
// 开发模式:app.getAppPath() = 项目根目录;生产模式:app.getAppPath() = resources/app.asar
config({ path: join(app.getAppPath(), ".env") });
// 同时尝试从 __dirname 加载,以兼容打包后的构建产物
config({ path: join(__dirname, "../../.env") });

import { ATTACHMENT_PICKER_EXTENSIONS, sniffMimeType } from "../shared/mime";
import { initPatternStore } from "./ai/pattern-store";
import { setProviderFetch } from "./ai/provider-fetch";
import { BrowserActionExecutor } from "./browser/browser-actions";
import { BrowserCaptureStore } from "./browser/browser-capture-store";
import { BrowserManager } from "./browser/browser-manager";
import { BrowserObserver } from "./browser/browser-observer";
import {
  createControlledWindowOpenHandler,
  denyBrowserPermissionCheck,
  denyBrowserPermissionRequest,
  hardenGuestWebPreferences,
  validateGuestAttachment,
} from "./browser/security-policy";
import { killAllShells } from "./core/agent/shells";
import { JsonlRunEventLog } from "./core/run/event-log";
import { recoverInterruptedRunEventLogs } from "./core/run/recovery";
import { JsonlSessionStore } from "./core/session/jsonl-store";
import { cleanupLegacyAtRefCache } from "./core/workspace/clone-cache";
import { ensureAskpassScript } from "./core/workspace/git-credentials";
import { stopAllHeadWatchers } from "./core/workspace/head-watcher";
import { getSetting, initDatabase, updateTask } from "./db";
import { setAgentRegistryDeps } from "./ipc/agent-tools";
import { registerAIHandlers, setWorkspaceFactoryDeps } from "./ipc/ai-handlers";
import { setRunEventLog } from "./ipc/ai-task-control";
import { registerAttachmentHandlers } from "./ipc/attachment-handlers";
import { setAutomationRunNotificationClickHandler } from "./ipc/automation-notifications";
import {
  startAutomationScheduler,
  stopAutomationScheduler,
} from "./ipc/automation-service";
import { registerAutomationsHandlers } from "./ipc/automations-handlers";
import {
  registerBrowserHandlers,
  sendBrowserState,
} from "./ipc/browser-handlers";
import { registerChatHandlers } from "./ipc/chat-handlers";
import {
  firecrawlCredentialResolver,
  registerCredentialsHandlers,
  tavilyCredentialResolver,
} from "./ipc/credentials-handlers";
import { batchTestCredentials } from "./ipc/credentials-monitor";
import { registerFileHandlers } from "./ipc/file-handlers";
import { registerGitDiffHandlers } from "./ipc/git-diff-handler";
import {
  credentialResolver,
  registerGitHubHandlers,
} from "./ipc/github-handlers";
import { registerGitLabHandlers } from "./ipc/gitlab-handlers";
import { registerLlmConfigHandlers } from "./ipc/llm-config-handlers";
import { registerLocalGitHandlers } from "./ipc/local-git-handlers";
import { registerMcpHandlers } from "./ipc/mcp-handlers";
import { registerMediaHandlers } from "./ipc/media-handlers";
import { mediaJobWatcher } from "./ipc/media-job-watcher";
import { registerSettingsHandlers } from "./ipc/settings-handlers";
import { registerTaskTraceHandlers } from "./ipc/task-trace-handlers";
import { registerToolWhitelistHandlers } from "./ipc/tool-whitelist-handlers";
import { registerWorkspaceHandlers } from "./ipc/workspace-handlers";
import { mcpManager } from "./mcp/manager";
import { bootstrapProxy } from "./proxy-bootstrap";
import { createProxyAwareFetch } from "./proxy-fetch";
import { skillRegistry } from "./skills";
import { initSkillDiscovery } from "./skills-runtime";
import { parseRange } from "./utils/http-range";

let mainWindow: BrowserWindow | null = null;
let browserManager: BrowserManager | null = null;
let browserObserver: BrowserObserver | null = null;
let browserActions: BrowserActionExecutor | null = null;
let browserCaptureStore: BrowserCaptureStore | null = null;
const RUN_EVENT_LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

// 开发模式下抑制 Electron 安全警告(Vite HMR 需要 unsafe-eval)
if (process.env.ELECTRON_RENDERER_URL) {
  process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = "true";
}

// 注册用于服务本地文件的自定义协议(必须在 app.ready 之前)
protocol.registerSchemesAsPrivileged([
  {
    scheme: "local-file",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
    },
  },
]);

// 所有 Electron WebContents 共用同一条最小权限基线。页面弹窗永远
// 不创建 BrowserWindow；合法 HTTP(S) 目标只在当前受控内容中导航。
app.on("web-contents-created", (_event, contents) => {
  contents.session.setPermissionCheckHandler(denyBrowserPermissionCheck);
  contents.session.setPermissionRequestHandler(denyBrowserPermissionRequest);
  contents.setWindowOpenHandler(
    createControlledWindowOpenHandler((url) => {
      void contents.loadURL(url);
    }),
  );

  contents.on("will-attach-webview", (event, webPreferences, params) => {
    hardenGuestWebPreferences(
      webPreferences as unknown as Record<string, unknown>,
    );
    try {
      validateGuestAttachment({
        partition: params.partition ?? webPreferences.partition ?? "",
        src: params.src ?? "",
      });
    } catch (error) {
      event.preventDefault();
      console.warn(
        "[browser-security] Blocked unsafe webview attachment:",
        error instanceof Error ? error.message : "invalid guest configuration",
      );
    }
  });
});

const createWindow = (): BrowserWindow => {
  let windowBrowserManager: BrowserManager | null = null;
  let windowBrowserObserver: BrowserObserver | null = null;
  let windowBrowserCaptureStore: BrowserCaptureStore | null = null;
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 16 },
    vibrancy: "under-window",
    visualEffectState: "active",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // 开发模式:从 vite dev server 加载;生产模式:加载构建产物文件
  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }

  mainWindow.on("closed", () => {
    windowBrowserObserver?.dispose();
    windowBrowserCaptureStore?.clear();
    void windowBrowserManager?.dispose();
    if (browserManager === windowBrowserManager) browserManager = null;
    if (browserObserver === windowBrowserObserver) browserObserver = null;
    if (browserCaptureStore === windowBrowserCaptureStore) {
      browserCaptureStore = null;
      browserActions = null;
    }
    mainWindow = null;
  });

  // 拦截任何离开 app shell 的顶层导航。可捕获右键菜单中的「打开链接」
  // (会绕过 React 的 onClick)、把 URL 拖放到窗口上,以及任何漏过
  // renderer 端 useLinkRouter 的 `<a>` 默认行为。若无此拦截,这些途径
  // 会用远程页面替换掉应用 UI。
  const APP_ORIGINS = new Set([process.env.ELECTRON_RENDERER_URL, "file://"]);
  mainWindow.webContents.on("will-navigate", (event, url) => {
    try {
      const target = new URL(url);
      // 允许同源导航回到 app shell。
      const isAppOrigin =
        url.startsWith("file://") ||
        Array.from(APP_ORIGINS).some((o) => o && url.startsWith(o));
      if (isAppOrigin) return;
      event.preventDefault();
      if (["http:", "https:", "mailto:", "tel:"].includes(target.protocol)) {
        void shell.openExternal(target.href);
      }
    } catch {
      event.preventDefault();
    }
  });
  // 对 window.open / target=_blank 做同样拦截 —— 绝不允许从聊天内容
  // 派生出新的 BrowserWindow;一律转交给系统浏览器。
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const target = new URL(url);
      if (["http:", "https:", "mailto:", "tel:"].includes(target.protocol)) {
        void shell.openExternal(target.href);
      }
    } catch {
      // 静默丢弃格式错误的 URL。
    }
    return { action: "deny" };
  });

  const ownerWindow = mainWindow;
  windowBrowserManager = new BrowserManager(ownerWindow, {
    onTabsChanged: (tabs) => sendBrowserState(ownerWindow, tabs),
  });
  windowBrowserCaptureStore = new BrowserCaptureStore();
  windowBrowserObserver = new BrowserObserver(windowBrowserManager, {
    captureStore: windowBrowserCaptureStore,
  });
  browserManager = windowBrowserManager;
  browserCaptureStore = windowBrowserCaptureStore;
  browserObserver = windowBrowserObserver;
  browserActions = new BrowserActionExecutor(
    windowBrowserManager,
    windowBrowserObserver,
  );

  return mainWindow;
};

const openAutomationTriageFromNotification = (runId: string): void => {
  const win = mainWindow ?? BrowserWindow.getAllWindows()[0] ?? createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();

  const send = () => win.webContents.send("automations:open-triage", { runId });
  if (win.webContents.isLoading()) {
    win.webContents.once("did-finish-load", send);
  } else {
    send();
  }
};

app.whenReady().then(async () => {
  // 开发模式下 macOS dock 显示默认 Electron 图标(build/icon.icns 仅在
  // electron-builder 打包时生效)。手动设置 dock 图标,让 `pnpm dev` 也能
  // 看到品牌 logo;打包后的应用走 .icns,无需此分支。
  if (!app.isPackaged && process.platform === "darwin") {
    const devIcon = nativeImage.createFromPath(
      join(app.getAppPath(), "brand/png/icon-512.png"),
    );
    if (!devIcon.isEmpty()) {
      app.dock?.setIcon(devIcon);
    }
  }

  // 系统「关于」面板:设置名称与版本。
  // iconPath 仅在 Linux/Windows 生效;macOS 的关于面板图标取自 app bundle
  // 图标(打包后即 build/icon.icns),运行时无法覆盖。
  app.setAboutPanelOptions({
    applicationName: "Workspace Agent",
    applicationVersion: app.getVersion(),
    ...(process.platform === "darwin"
      ? {}
      : { iconPath: join(app.getAppPath(), "brand/png/icon-512.png") }),
  });

  // 模式采集 sink。在任何任务运行前初始化以启用;在此之前
  // appendPattern 为空操作。
  initPatternStore(join(app.getPath("userData"), "patterns.jsonl"));

  // 让主进程 fetch + 派生的 git 子进程都走用户的代理(系统或 env)。
  // 必须在任何 IPC handler 注册或工作区 clone 之前执行,使后续每个
  // 网络调用都继承该代理。
  await bootstrapProxy({
    resolveProxy: (url) => session.defaultSession.resolveProxy(url),
  });

  // 按请求感知代理的 fetch。`bootstrapProxy` 的全局 EnvHttpProxyAgent
  // 基于一次启动探测对每个 host 应用相同代理 —— 这会破坏分流配置
  // (Mihomo / Clash):部分 host 走 DIRECT,其余走代理。此 wrapper
  // 对每个请求调用 `session.resolveProxy(url)`,并用该 URL 对应的
  // dispatcher 覆盖全局 dispatcher。
  const proxyAwareFetch = createProxyAwareFetch({
    resolveProxy: (url) => session.defaultSession.resolveProxy(url),
  });
  // 让 AI SDK 的模型流量也走同一套按 host 的 fetch —— 全局 env 代理
  // 可能缓冲流式响应;按 host 的 PAC 解析可能为 API host 选择不缓冲的
  // 路径。见 provider-fetch.ts。
  setProviderFetch(proxyAwareFetch);

  // 同一套按 host 的 PAC 来源,以原始 resolver 形式暴露给派生的
  // `git` 子进程。`git-proxy-env.ts` 会原样消费 Chromium 的 PAC 输出。
  // git 子进程继承了由 `bootstrapProxy` 写入的 `process.env.HTTPS_PROXY`,
  // 这对分流是错误的 —— 因此每次 git 调用改用此 resolver 重建 env。
  const resolveProxy = (url: string): Promise<string> =>
    session.defaultSession.resolveProxy(url);

  // 注册 local-file:// 协议以服务本地文件(用于 PDF/视频/图片预览)。
  // 支持 HTTP Range:视频可边下边播 + 拖拽 seek,大 PDF 按页按需加载,
  // 大图渐进式加载 —— 而不是把整文件读进内存再一次性返回。
  const handleLocalFile = async (request: Request): Promise<Response> => {
    // URL 格式:local-file://open?path=/absolute/path/to/file.pdf
    const url = new URL(request.url);
    const filePath = url.searchParams.get("path");
    if (!filePath) {
      return new Response("Missing path parameter", { status: 400 });
    }

    let fileSize: number;
    try {
      const st = await stat(filePath);
      if (!st.isFile()) {
        return new Response("Not a file", { status: 404 });
      }
      fileSize = st.size;
    } catch {
      return new Response("File not found", { status: 404 });
    }

    const contentType = sniffMimeType(filePath);
    const rangeHeader = request.headers.get("range");

    // 无 Range:整文件流式返回。声明 Accept-Ranges,让浏览器后续 seek 时改发 Range。
    if (!rangeHeader) {
      const body = Readable.toWeb(
        createReadStream(filePath),
      ) as ReadableStream<Uint8Array>;
      return new Response(body, {
        status: 200,
        headers: {
          "Content-Type": contentType,
          "Content-Length": String(fileSize),
          "Accept-Ranges": "bytes",
        },
      });
    }

    const range = parseRange(rangeHeader, fileSize);
    if (!range) {
      // 不可满足的 Range → 416 + Content-Range: bytes */size
      return new Response("Range Not Satisfiable", {
        status: 416,
        headers: { "Content-Range": `bytes */${fileSize}` },
      });
    }

    const { start, end } = range;
    // createReadStream 的 end 为闭区间,正好对应 HTTP Range 语义。
    const body = Readable.toWeb(
      createReadStream(filePath, { start, end }),
    ) as ReadableStream<Uint8Array>;
    return new Response(body, {
      status: 206,
      headers: {
        "Content-Type": contentType,
        "Content-Range": `bytes ${start}-${end}/${fileSize}`,
        "Content-Length": String(end - start + 1),
        "Accept-Ranges": "bytes",
      },
    });
  };

  // 默认 session:宿主 renderer 的 <img> 缩略图、PDF / 视频预览。
  protocol.handle("local-file", handleLocalFile);
  // 本地产物预览使用独立的内存 Profile。真实网页 Profile 不注册
  // local-file://，因此远端页面无法借自定义协议读取本地文件。
  session
    .fromPartition("artifact-preview")
    .protocol.handle("local-file", handleLocalFile);

  // 初始化 SQLite 数据库
  await initDatabase();

  // JSONL session store —— 聊天会话与消息的唯一后端。
  // 一次性的 SQLite→JSONL 迁移在 M3 PR 1 中发布,并在 M3 PR 2 中确认
  // 稳定后移除;早于 M3 PR 1 的安装版本已在首次启动时完成迁移。
  const sessionStore = new JsonlSessionStore(
    join(homedir(), ".filework", "sessions"),
  );
  const runEventLog = new JsonlRunEventLog(
    join(homedir(), ".filework", "run-events"),
  );
  try {
    const recovered = await recoverInterruptedRunEventLogs(runEventLog, {
      updateTask,
      appendRecoveredMessageParts: async ({
        sessionId,
        assistantMessageId,
        parts,
        timestamp,
      }) => {
        await sessionStore.appendMessageParts(
          sessionId,
          assistantMessageId,
          parts,
          { replaceSubagentBatches: true, timestamp },
        );
      },
      appendInterruptedMessage: async ({
        sessionId,
        assistantMessageId,
        message,
        timestamp,
      }) => {
        await sessionStore.appendMessagePart(
          sessionId,
          assistantMessageId,
          {
            type: "error",
            message,
            errorType: "interrupted",
            recoveryActions: ["retry", "new_chat"],
          },
          { contentFallback: message, timestamp },
        );
      },
    });
    if (recovered.length > 0) {
      console.warn(
        `[Main] Marked ${recovered.filter((run) => !run.terminal).length} interrupted run(s) after previous shutdown; cleaned ${recovered.length} residual run event log(s).`,
      );
    }
    runEventLog.pruneOlderThan(
      new Date(Date.now() - RUN_EVENT_LOG_RETENTION_MS),
    );
  } catch (err) {
    console.warn(
      "[Main] Failed to recover or prune run event logs:",
      err instanceof Error ? err.message : err,
    );
  }
  setRunEventLog(runEventLog);

  // M7: 在任何 git 调用之前写入 GIT_ASKPASS 辅助脚本。
  // token 通过 env 提供,绝不嵌入 .git/config 的 URL 中。
  const askpassPath = await ensureAskpassScript(
    join(homedir(), ".filework", "internal"),
  );

  // M6: workspace factory 依赖 —— 供 ai-handlers 实例化 GitHub / GitLab
  // 工作区(clone 到各 provider 专属的缓存目录)。
  const githubCacheDir = join(homedir(), ".filework", "cache", "github");
  const gitlabCacheDir = join(homedir(), ".filework", "cache", "gitlab");

  // 一次性迁移到按 repo 的 clone 布局。早期里程碑遗留的
  // `<project>@<ref>` 目录现已成为冗余(新布局是每个 repo 一份 clone,
  // 分支作为工作树状态)。在任何工作区实例化前清扫它们。
  try {
    const { removed } = await cleanupLegacyAtRefCache([
      githubCacheDir,
      gitlabCacheDir,
    ]);
    if (removed > 0) {
      console.log(`[clone-cache] removed ${removed} legacy @ref clone(s)`);
    }
  } catch (err) {
    console.warn(
      "[clone-cache] legacy cleanup failed:",
      err instanceof Error ? err.message : err,
    );
  }

  setWorkspaceFactoryDeps({
    resolveToken: credentialResolver,
    githubCacheDir,
    gitlabCacheDir,
    askpassPath,
    resolveProxy,
  });

  // agent 的 web 工具(webFetch / webFetchRendered / webSearch /
  // webScrape)使用同一套感知代理的 fetch,以遵循分流 PAC 规则
  // (Mihomo/Clash CN-DIRECT 等)。Tavily / Firecrawl resolver 是门控 ——
  // 为 null 时,对应工具不会被注册,模型若尝试调用会得到一个结构化的
  // 「configure credentials」错误。
  setAgentRegistryDeps({
    fetchFn: proxyAwareFetch,
    resolveTavilyToken: tavilyCredentialResolver,
    resolveFirecrawlToken: firecrawlCredentialResolver,
    getBrowserToolsDependencies: () => {
      if (
        !browserManager ||
        !browserObserver ||
        !browserActions ||
        !browserCaptureStore
      ) {
        return null;
      }
      return {
        manager: browserManager,
        observer: browserObserver,
        actions: browserActions,
        captureStore: browserCaptureStore,
      };
    },
  });

  // 注册 IPC handler
  registerFileHandlers();
  registerAIHandlers();
  registerSettingsHandlers();
  registerBrowserHandlers({
    getBrowserManager: () => browserManager,
    getMainWindow: () => mainWindow,
  });
  registerLlmConfigHandlers();
  mediaJobWatcher.configure({ fetchFn: proxyAwareFetch });
  registerMediaHandlers({ fetchFn: proxyAwareFetch });
  registerWorkspaceHandlers();
  registerLocalGitHandlers();
  registerGitDiffHandlers();
  registerAutomationsHandlers();
  registerChatHandlers(sessionStore);
  registerAttachmentHandlers();
  registerTaskTraceHandlers();
  registerToolWhitelistHandlers();
  registerCredentialsHandlers();
  setAutomationRunNotificationClickHandler((run) =>
    openAutomationTriageFromNotification(run.id),
  );
  startAutomationScheduler();

  // MCP —— 加载持久化的服务器配置,注册 IPC,并在后台打开每个已启用的
  // 服务器。连接失败按服务器隔离(manager 会将其切到 error 状态),
  // 因此单个配置错误的条目不会阻塞应用启动。
  mcpManager.init();
  registerMcpHandlers();
  void mcpManager.connectAll();

  registerGitHubHandlers({
    resolveToken: credentialResolver,
    cacheDir: githubCacheDir,
    askpassPath,
    fetchFn: proxyAwareFetch,
    resolveProxy,
  });
  registerGitLabHandlers({
    resolveToken: credentialResolver,
    cacheDir: gitlabCacheDir,
    askpassPath,
    fetchFn: proxyAwareFetch,
    resolveProxy,
  });

  // M7: 在 IPC 接线完成后启动凭据健康监控。
  // Fire-and-forget —— 错误在 batchTestCredentials 内部记录日志。
  batchTestCredentials()
    .then(({ tested, skipped }) => {
      console.log(
        `[credentials-monitor] tested ${tested}, skipped ${skipped} (debounced)`,
      );
    })
    .catch((err) => {
      console.warn(
        "[credentials-monitor] batch test threw:",
        err instanceof Error ? err.message : err,
      );
    });

  // 在启动时发现个人级 skill(项目级 skill 在打开工作区时加载)。
  // 每个个人 / 附加 skill 都由 Skills 弹窗中的逐个开关门控 —— 发现它们
  // 以便出现在清单中,但仅注册用户已启用的 ID。
  const enabledIdsRaw = getSetting("skills.enabled-ids");
  let enabledSkillIds: string[] = [];
  if (enabledIdsRaw) {
    try {
      const parsed = JSON.parse(enabledIdsRaw);
      if (Array.isArray(parsed)) {
        enabledSkillIds = parsed.filter(
          (v): v is string => typeof v === "string",
        );
      }
    } catch (err) {
      console.warn(
        "[startup] Malformed skills.enabled-ids setting, ignoring:",
        err instanceof Error ? err.message : err,
      );
    }
  }
  initSkillDiscovery(skillRegistry, "", undefined, enabledSkillIds).catch(
    (err) => {
      console.warn("[startup] Failed to discover personal skills:", err);
    },
  );

  // 目录选择器
  ipcMain.handle(
    "dialog:openDirectory",
    async (_event, defaultPath?: string) => {
      const result = await dialog.showOpenDialog({
        properties: ["openDirectory"],
        defaultPath: defaultPath || undefined,
      });
      return result.canceled ? null : result.filePaths[0];
    },
  );

  // 多文件选择器 —— 聊天附件编辑器。
  ipcMain.handle("dialog:openFiles", async (): Promise<string[]> => {
    const result = await dialog.showOpenDialog({
      properties: ["openFile", "multiSelections"],
      filters: [
        {
          name: "Images, PDFs & text",
          extensions: [...ATTACHMENT_PICKER_EXTENSIONS],
        },
        { name: "All Files", extensions: ["*"] },
      ],
    });
    return result.canceled ? [] : result.filePaths;
  });

  // 在 Finder / 文件管理器中显示
  ipcMain.handle("shell:showInFinder", async (_event, path: string) => {
    shell.showItemInFolder(path);
  });

  // 打开 macOS「文件和文件夹」隐私面板,让用户授予对
  // ~/Downloads / ~/Documents / ~/Desktop 等的访问权限。非 macOS 上为空操作。
  ipcMain.handle("shell:openFilesAndFoldersSettings", async () => {
    if (process.platform === "darwin") {
      await shell.openExternal(
        "x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders",
      );
    }
  });

  // 把 URL 交给系统默认浏览器。供应用内 BrowserPanel 的「在系统浏览器中
  // 打开」操作,以及聊天链接路由中的 Cmd/Ctrl-click 回退使用。scheme
  // 白名单挡掉 `file:` / `javascript:` —— renderer 代码已沙箱化,但 IPC
  // 面没有。
  //
  // 拒绝时抛出异常,使 renderer 能向用户呈现「无法打开」,而不是静默
  // 吞掉拼写错误和格式错误的 href。
  ipcMain.handle("shell:openExternal", async (_event, url: unknown) => {
    if (typeof url !== "string") {
      throw new Error("openExternal: url must be a string");
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`openExternal: invalid URL: ${url.slice(0, 200)}`);
    }
    if (!["http:", "https:", "mailto:", "tel:"].includes(parsed.protocol)) {
      throw new Error(`openExternal: scheme not allowed: ${parsed.protocol}`);
    }
    // 传入规范化后的 href,而非原始字符串 —— 避免 URL 解析器已剥离的
    // 控制字符 / null 字节抵达操作系统。
    await shell.openExternal(parsed.href);
  });

  // 设置 Content-Security-Policy(仅生产环境 —— 开发环境的 Vite HMR 需要 unsafe-eval)
  if (!process.env.ELECTRON_RENDERER_URL) {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          "Content-Security-Policy": [
            // img-src / media-src / frame-src 允许 https:/http:,使 web
            // 工具结果(搜索图片、页面图片、<video> 直链、
            // YouTube/Vimeo/Bilibili 内嵌)能在聊天中内联渲染。脚本仍
            // 锁定为 'self',因此 iframe 内嵌在其自身 origin 中沙箱运行,
            // 无法以脚本访问我们的 renderer。
            "default-src 'self' local-file:; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: local-file: https: http:; media-src local-file: https: http: blob:; frame-src local-file: https:",
          ],
        },
      });
    });
  }

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  const manager = browserManager;
  browserManager = null;
  void manager?.dispose();
  stopAutomationScheduler();
  stopAllHeadWatchers();
  killAllShells();
  // 断开 MCP 服务器连接 —— stdio transport 会派生子进程,否则会在
  // Electron 进程退出后残留。
  void mcpManager.disconnectAll();
});
