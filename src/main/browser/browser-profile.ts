import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";

import {
  type DownloadItem,
  type Event,
  type Session,
  session,
  type WebContents,
} from "electron";

import type { BrowserDownloadState } from "../../shared/browser";
import {
  denyBrowserPermissionCheck,
  denyBrowserPermissionRequest,
} from "./security-policy";

export interface BrowserDownloadContext {
  event: Event;
  item: DownloadItem;
  partition: string;
  webContents: WebContents;
}

export interface BrowserProfileOptions {
  onDownload?: (context: BrowserDownloadContext) => void;
  proxy?: Electron.ProxyConfig;
  spellCheckerEnabled?: boolean;
}

const initializedProfiles = new Map<string, Promise<Session>>();
const profileDownloadHandlers = new Map<
  string,
  (context: BrowserDownloadContext) => void
>();

export interface ControlledBrowserDownloadOptions {
  getPreferences: () => { askEveryTime: boolean; directory: string };
  getDefaultDirectory: () => string;
  onState: (state: BrowserDownloadState) => void;
  createId?: () => string;
  pathExists?: (path: string) => boolean;
}

const safeDownloadMetric = (read: () => number): number => {
  try {
    const value = read();
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  } catch {
    return 0;
  }
};

const safeDownloadSavePath = (item: DownloadItem): string | undefined => {
  try {
    return item.getSavePath() || undefined;
  } catch {
    return undefined;
  }
};

export const sanitizeBrowserDownloadFilename = (suggested: string): string => {
  const leaf = suggested.split(/[\\/]/).pop()?.trim() ?? "";
  const withoutControlCharacters = [...leaf.normalize("NFKC")]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127 ? "_" : character;
    })
    .join("");
  const sanitized = withoutControlCharacters
    .replace(/[<>:"/\\|?*]/g, "_")
    .replace(/[. ]+$/g, "")
    .slice(0, 180)
    .trim();
  return sanitized && sanitized !== "." && sanitized !== ".."
    ? sanitized
    : "download";
};

export const resolveAvailableDownloadPath = (
  candidate: string,
  pathExists: (path: string) => boolean = existsSync,
): string => {
  if (!pathExists(candidate)) return candidate;
  const directory = dirname(candidate);
  const extension = extname(candidate);
  const stem = basename(candidate, extension);
  for (let suffix = 1; suffix <= 9_999; suffix += 1) {
    const next = join(directory, `${stem} (${suffix})${extension}`);
    if (!pathExists(next)) return next;
  }
  throw new Error("Unable to allocate a unique browser download path");
};

export const setBrowserProfileDownloadHandler = (
  partition: string,
  handler: ((context: BrowserDownloadContext) => void) | null,
): void => {
  if (handler) profileDownloadHandlers.set(partition, handler);
  else profileDownloadHandlers.delete(partition);
};

export const createControlledBrowserDownloadHandler = (
  options: ControlledBrowserDownloadOptions,
): ((context: BrowserDownloadContext) => void) => {
  const createId = options.createId ?? randomUUID;
  const pathExists = options.pathExists ?? existsSync;

  return ({ item }) => {
    const id = createId();
    const filename = sanitizeBrowserDownloadFilename(item.getFilename());
    let configuredSavePath: string | undefined;

    const emit = (status: BrowserDownloadState["status"]): void => {
      options.onState({
        id,
        filename,
        status,
        receivedBytes: safeDownloadMetric(() => item.getReceivedBytes()),
        totalBytes: safeDownloadMetric(() => item.getTotalBytes()),
        savePath: safeDownloadSavePath(item) ?? configuredSavePath,
      });
    };

    try {
      const preferences = options.getPreferences();
      const targetDirectory =
        preferences.directory.trim() || options.getDefaultDirectory();
      const suggestedPath = join(targetDirectory, filename);

      if (preferences.askEveryTime) {
        item.setSaveDialogOptions({
          defaultPath: suggestedPath,
          properties: ["createDirectory", "showOverwriteConfirmation"],
        });
      } else {
        configuredSavePath = resolveAvailableDownloadPath(
          suggestedPath,
          pathExists,
        );
        item.setSavePath(configuredSavePath);
      }

      item.on("updated", (_event, state) => emit(state));
      item.once("done", (_event, state) => emit(state));
      emit("progressing");
    } catch {
      item.cancel();
      emit("cancelled");
    }
  };
};

export const initializeBrowserProfile = (
  partition: string,
  options: BrowserProfileOptions = {},
): Promise<Session> => {
  if (options.onDownload) {
    setBrowserProfileDownloadHandler(partition, options.onDownload);
  }
  const existing = initializedProfiles.get(partition);
  if (existing) return existing;

  const initialization = (async () => {
    const browserSession = session.fromPartition(partition);
    browserSession.setPermissionCheckHandler(denyBrowserPermissionCheck);
    browserSession.setPermissionRequestHandler(denyBrowserPermissionRequest);
    browserSession.setSpellCheckerEnabled(options.spellCheckerEnabled ?? true);
    browserSession.on("will-download", (event, item, webContents) => {
      const handler = profileDownloadHandlers.get(partition);
      if (handler) {
        handler({
          event,
          item,
          partition,
          webContents,
        });
        return;
      }

      // 下载 UI 在后续阶段接入；在此之前不允许页面静默写入磁盘。
      event.preventDefault();
      item.cancel();
    });
    await browserSession.setProxy(options.proxy ?? { mode: "system" });
    return browserSession;
  })();

  initializedProfiles.set(partition, initialization);
  void initialization.catch(() => {
    if (initializedProfiles.get(partition) === initialization) {
      initializedProfiles.delete(partition);
    }
  });
  return initialization;
};

export const clearBrowserProfileData = async (
  partition: string,
): Promise<void> => {
  const browserSession = session.fromPartition(partition);
  await Promise.all([
    browserSession.clearData({
      dataTypes: [
        "backgroundFetch",
        "cache",
        "cookies",
        "downloads",
        "fileSystems",
        "indexedDB",
        "localStorage",
        "serviceWorkers",
        "webSQL",
      ],
    }),
    browserSession.clearAuthCache(),
    browserSession.clearCodeCaches({ urls: [] }),
    browserSession.clearHostResolverCache(),
  ]);
};

export const redactBrowserUrlForLog = (raw: string): string => {
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return "[invalid-url]";
  }
};
