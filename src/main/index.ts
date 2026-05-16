import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { config } from "dotenv";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  protocol,
  session,
  shell,
} from "electron";

// Load .env from app root (must run before any env access)
// In dev: app.getAppPath() = project root; in prod: app.getAppPath() = resources/app.asar
config({ path: join(app.getAppPath(), ".env") });
// Also try from __dirname for bundled builds
config({ path: join(__dirname, "../../.env") });

import { JsonlSessionStore } from "./core/session/jsonl-store";
import { cleanupLegacyAtRefCache } from "./core/workspace/clone-cache";
import { ensureAskpassScript } from "./core/workspace/git-credentials";
import { stopAllHeadWatchers } from "./core/workspace/head-watcher";
import { initDatabase } from "./db";
import { setAgentRegistryDeps } from "./ipc/agent-tools";
import { registerAIHandlers, setWorkspaceFactoryDeps } from "./ipc/ai-handlers";
import { registerChatHandlers } from "./ipc/chat-handlers";
import {
  firecrawlCredentialResolver,
  registerCredentialsHandlers,
  tavilyCredentialResolver,
} from "./ipc/credentials-handlers";
import { batchTestCredentials } from "./ipc/credentials-monitor";
import { registerFileHandlers } from "./ipc/file-handlers";
import {
  credentialResolver,
  registerGitHubHandlers,
} from "./ipc/github-handlers";
import { registerGitLabHandlers } from "./ipc/gitlab-handlers";
import { registerLlmConfigHandlers } from "./ipc/llm-config-handlers";
import { registerLocalGitHandlers } from "./ipc/local-git-handlers";
import { registerMediaHandlers } from "./ipc/media-handlers";
import { mediaJobWatcher } from "./ipc/media-job-watcher";
import { registerSettingsHandlers } from "./ipc/settings-handlers";
import { registerTaskTraceHandlers } from "./ipc/task-trace-handlers";
import { registerWorkspaceHandlers } from "./ipc/workspace-handlers";
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
};

app.whenReady().then(async () => {
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
      const ext = filePath.split(".").pop()?.toLowerCase();
      const mimeMap: Record<string, string> = {
        pdf: "application/pdf",
        mp4: "video/mp4",
        webm: "video/webm",
        ogg: "video/ogg",
        mov: "video/quicktime",
        m4v: "video/x-m4v",
        png: "image/png",
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        gif: "image/gif",
        webp: "image/webp",
      };
      const contentType = (ext && mimeMap[ext]) || "application/octet-stream";
      return new Response(buffer, {
        headers: { "Content-Type": contentType },
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
    fetchFn: proxyAwareFetch,
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
  registerChatHandlers(sessionStore);
  registerTaskTraceHandlers();
  registerCredentialsHandlers();
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

  // Discover personal-level skills at startup (project skills are loaded on workspace open)
  initSkillDiscovery(skillRegistry, "").catch((err) => {
    console.warn("[startup] Failed to discover personal skills:", err);
  });

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

  // Reveal in Finder / file manager
  ipcMain.handle("shell:showInFinder", async (_event, path: string) => {
    shell.showItemInFolder(path);
  });

  // Set Content-Security-Policy (production only — dev needs unsafe-eval for Vite HMR)
  if (!process.env.ELECTRON_RENDERER_URL) {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          "Content-Security-Policy": [
            // img-src allows https:/http: so that web tool results
            // (webSearch images, webFetch page images) render in the
            // chat gallery. Remote images are display-only — they don't
            // grant script execution, so this is bounded in risk.
            "default-src 'self' local-file:; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: local-file: https: http:; media-src local-file:; frame-src local-file:",
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
});
