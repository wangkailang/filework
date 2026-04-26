import { readFile } from "node:fs/promises";
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

import { initDatabase } from "./db";
import { registerAIHandlers } from "./ipc/ai-handlers";
import { registerChatHandlers } from "./ipc/chat-handlers";
import { registerFileHandlers } from "./ipc/file-handlers";
import { registerLlmConfigHandlers } from "./ipc/llm-config-handlers";
import { registerSettingsHandlers } from "./ipc/settings-handlers";
import { registerTaskTraceHandlers } from "./ipc/task-trace-handlers";
import { registerWorkspaceHandlers } from "./ipc/workspace-handlers";
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

  // Register IPC handlers
  registerFileHandlers();
  registerAIHandlers();
  registerSettingsHandlers();
  registerLlmConfigHandlers();
  registerWorkspaceHandlers();
  registerChatHandlers();
  registerTaskTraceHandlers();

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
            "default-src 'self' local-file:; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src local-file:; frame-src local-file:",
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
