import {
  type DownloadItem,
  type Event,
  type Session,
  session,
  type WebContents,
} from "electron";

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

export const initializeBrowserProfile = (
  partition: string,
  options: BrowserProfileOptions = {},
): Promise<Session> => {
  const existing = initializedProfiles.get(partition);
  if (existing) return existing;

  const initialization = (async () => {
    const browserSession = session.fromPartition(partition);
    browserSession.setPermissionCheckHandler(denyBrowserPermissionCheck);
    browserSession.setPermissionRequestHandler(denyBrowserPermissionRequest);
    browserSession.setSpellCheckerEnabled(options.spellCheckerEnabled ?? true);
    browserSession.on("will-download", (event, item, webContents) => {
      if (options.onDownload) {
        options.onDownload({
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
