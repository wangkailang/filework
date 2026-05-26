import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
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

// Load .env from app root (must run before any env access)
// In dev: app.getAppPath() = project root; in prod: app.getAppPath() = resources/app.asar
config({ path: join(app.getAppPath(), ".env") });
// Also try from __dirname for bundled builds
config({ path: join(__dirname, "../../.env") });

import { ATTACHMENT_PICKER_EXTENSIONS, sniffMimeType } from "../shared/mime";
import { initPatternStore } from "./ai/pattern-store";
import { killAllShells } from "./core/agent/shells";
import { JsonlSessionStore } from "./core/session/jsonl-store";
import { cleanupLegacyAtRefCache } from "./core/workspace/clone-cache";
import { ensureAskpassScript } from "./core/workspace/git-credentials";
import { stopAllHeadWatchers } from "./core/workspace/head-watcher";
import { getSetting, initDatabase } from "./db";
import { setAgentRegistryDeps } from "./ipc/agent-tools";
import { registerAIHandlers, setWorkspaceFactoryDeps } from "./ipc/ai-handlers";
import { registerAttachmentHandlers } from "./ipc/attachment-handlers";
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

let mainWindow: BrowserWindow | null = null;

// Suppress Electron security warnings in development (Vite HMR requires unsafe-eval)
if (process.env.ELECTRON_RENDERER_URL) {
  process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = "true";
}

// Register custom protocol for serving local files (must be before app.ready)
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

const createWindow = () => {
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
      // Enables the in-app right-side BrowserPanel — webviews are
      // chrome guest processes, fully sandboxed from the host renderer.
      webviewTag: true,
    },
  });

  // Dev: load from vite dev server; Prod: load built file
  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // Trap any top-level navigation away from the app shell. This catches
  // right-click → "Open Link" from the context menu (which bypasses
  // React's onClick), drag-drop of URLs onto the window, and any
  // would-be `<a>` default that slipped past the renderer-side
  // useLinkRouter. Without this trap, those vectors replace the app UI
  // with a remote page.
  const APP_ORIGINS = new Set([process.env.ELECTRON_RENDERER_URL, "file://"]);
  mainWindow.webContents.on("will-navigate", (event, url) => {
    try {
      const target = new URL(url);
      // Allow same-origin navigation back to the app shell.
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
  // Same trap for window.open / target=_blank — never let a new
  // BrowserWindow spawn from chat content; route to the OS browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const target = new URL(url);
      if (["http:", "https:", "mailto:", "tel:"].includes(target.protocol)) {
        void shell.openExternal(target.href);
      }
    } catch {
      // Drop malformed URLs silently.
    }
    return { action: "deny" };
  });
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

  // Pattern capture sink. Opt-in by initializing before any task runs;
  // appendPattern is a no-op until this fires.
  initPatternStore(join(app.getPath("userData"), "patterns.jsonl"));

  // Route main-process fetch + spawned git children through the user's
  // proxy (system or env). Must run before any IPC handler registration
  // or workspace clone, so every later network call inherits it.
  await bootstrapProxy({
    resolveProxy: (url) => session.defaultSession.resolveProxy(url),
  });

  // Per-request proxy-aware fetch. `bootstrapProxy`'s global
  // EnvHttpProxyAgent applies the same proxy to every host based on
  // one startup probe — that breaks split-routing setups (Mihomo /
  // Clash) where some hosts route DIRECT and others via proxy. This
  // wrapper consults `session.resolveProxy(url)` per request and
  // overrides the global dispatcher with the right one for that URL.
  const proxyAwareFetch = createProxyAwareFetch({
    resolveProxy: (url) => session.defaultSession.resolveProxy(url),
  });

  // Same per-host PAC source, exposed as a raw resolver for spawned
  // `git` children. `git-proxy-env.ts` consumes Chromium's PAC output
  // verbatim. The git subprocess inherits `process.env.HTTPS_PROXY`
  // seeded by `bootstrapProxy`, which is wrong for split-routing —
  // each git call rebuilds env from this resolver instead.
  const resolveProxy = (url: string): Promise<string> =>
    session.defaultSession.resolveProxy(url);

  // Register local-file:// protocol to serve local files (for PDF preview etc.)
  protocol.handle("local-file", async (request) => {
    // URL format: local-file://open?path=/absolute/path/to/file.pdf
    const url = new URL(request.url);
    const filePath = url.searchParams.get("path");
    if (!filePath) {
      return new Response("Missing path parameter", { status: 400 });
    }
    try {
      const buffer = await readFile(filePath);
      return new Response(buffer, {
        headers: { "Content-Type": sniffMimeType(filePath) },
      });
    } catch {
      return new Response("File not found", { status: 404 });
    }
  });

  // Initialize SQLite database
  await initDatabase();

  // JSONL session store — sole backend for chat sessions and messages.
  // The one-shot SQLite→JSONL migration shipped in M3 PR 1 and was
  // dropped in M3 PR 2 once stability was proven; users on a pre-M3 PR 1
  // install would have already been migrated on their first launch.
  const sessionStore = new JsonlSessionStore(
    join(homedir(), ".filework", "sessions"),
  );

  // M7: write the GIT_ASKPASS helper script before any git invocation.
  // The token is supplied via env, never embedded in .git/config URLs.
  const askpassPath = await ensureAskpassScript(
    join(homedir(), ".filework", "internal"),
  );

  // M6: workspace factory deps — used by ai-handlers to materialize
  // GitHub / GitLab workspaces (clones into provider-specific cache dirs).
  const githubCacheDir = join(homedir(), ".filework", "cache", "github");
  const gitlabCacheDir = join(homedir(), ".filework", "cache", "gitlab");

  // One-time migration to the per-repo clone layout. Pre-existing
  // `<project>@<ref>` directories from earlier milestones are now dead
  // weight (the new layout is one clone per repo with branches as
  // working-tree state). Sweep them before any workspace materializes.
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

  // The agent's web tools (webFetch / webFetchRendered / webSearch /
  // webScrape) use the same proxy-aware fetch so they honor split-
  // routing PAC rules (Mihomo/Clash CN-DIRECT etc.). Tavily / Firecrawl
  // resolvers are gates — when null, the corresponding tool isn't
  // registered and the model gets a structured "configure credentials"
  // error if it tries.
  setAgentRegistryDeps({
    fetchFn: proxyAwareFetch,
    resolveTavilyToken: tavilyCredentialResolver,
    resolveFirecrawlToken: firecrawlCredentialResolver,
  });

  // Register IPC handlers
  registerFileHandlers();
  registerAIHandlers();
  registerSettingsHandlers();
  registerLlmConfigHandlers();
  mediaJobWatcher.configure({ fetchFn: proxyAwareFetch });
  registerMediaHandlers({ fetchFn: proxyAwareFetch });
  registerWorkspaceHandlers();
  registerLocalGitHandlers();
  registerGitDiffHandlers();
  registerChatHandlers(sessionStore);
  registerAttachmentHandlers();
  registerTaskTraceHandlers();
  registerToolWhitelistHandlers();
  registerCredentialsHandlers();

  // MCP — load persisted server configs, register IPC, and open every
  // enabled server in the background. Connection failures are isolated
  // per server (the manager flips them to error state) so a misconfigured
  // entry can't block app startup.
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

  // M7: kick off the credential health monitor after IPC is wired.
  // Fire-and-forget — errors are logged inside batchTestCredentials.
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

  // Discover personal-level skills at startup (project skills are loaded
  // on workspace open). Each personal / additional skill is gated by a
  // per-skill toggle in the Skills modal — discover them so they appear
  // in the inventory, but only register the IDs the user has enabled.
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

  // Directory picker
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

  // Multi-file picker — chat attachment composer.
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

  // Reveal in Finder / file manager
  ipcMain.handle("shell:showInFinder", async (_event, path: string) => {
    shell.showItemInFolder(path);
  });

  // Open macOS "Files and Folders" privacy pane so user can grant access
  // to ~/Downloads / ~/Documents / ~/Desktop etc. No-op on non-macOS.
  ipcMain.handle("shell:openFilesAndFoldersSettings", async () => {
    if (process.platform === "darwin") {
      await shell.openExternal(
        "x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders",
      );
    }
  });

  // Hand a URL to the OS default browser. Used by the in-app BrowserPanel's
  // "open in system browser" action and the Cmd/Ctrl-click fallback in
  // the chat link router. Scheme allow-list keeps `file:` / `javascript:`
  // out — renderer code is sandboxed but the IPC surface isn't.
  //
  // Throws on rejection so the renderer can surface "couldn't open" to
  // the user instead of silently swallowing typos and malformed hrefs.
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
    // Pass the normalized href, not the raw string — keeps any control
    // chars / null bytes the URL parser stripped from reaching the OS.
    await shell.openExternal(parsed.href);
  });

  // Set Content-Security-Policy (production only — dev needs unsafe-eval for Vite HMR)
  if (!process.env.ELECTRON_RENDERER_URL) {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          "Content-Security-Policy": [
            // img-src / media-src / frame-src allow https:/http: so that
            // web tool results (search images, page images, <video>
            // direct links, YouTube/Vimeo/Bilibili embeds) render inline
            // in the chat. Scripts remain pinned to 'self', so iframe
            // embeds run sandboxed in their own origin without script
            // access to our renderer.
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
  stopAllHeadWatchers();
  killAllShells();
  // Disconnect MCP servers — stdio transports spawn child processes
  // that would otherwise linger after the Electron process exits.
  void mcpManager.disconnectAll();
});
