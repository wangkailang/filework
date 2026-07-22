import { parseBrowserUrl } from "../../shared/browser";

export const WEB_BROWSER_PARTITIONS = [
  "persist:in-app-browser",
  "in-app-browser",
  "persist:filework-browser",
] as const;

export const ARTIFACT_BROWSER_PARTITION = "artifact-preview";

const webBrowserPartitions = new Set<string>(WEB_BROWSER_PARTITIONS);

export interface GuestAttachment {
  partition: string;
  src: string;
}

export type GuestWebPreferences = Record<string, unknown>;

export const assertAgentBrowserUrl = (raw: string): URL => parseBrowserUrl(raw);

export const hardenGuestWebPreferences = (
  preferences: GuestWebPreferences,
): void => {
  delete preferences.preload;
  delete preferences.preloadURL;
  preferences.nodeIntegration = false;
  preferences.contextIsolation = true;
  preferences.sandbox = true;
  preferences.webSecurity = true;
};

const assertArtifactPreviewUrl = (raw: string): URL => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Invalid artifact preview URL");
  }
  if (url.protocol !== "local-file:") {
    throw new Error(
      `Artifact preview URL scheme is not allowed: ${url.protocol}`,
    );
  }
  return url;
};

export const validateGuestAttachment = ({
  partition,
  src,
}: GuestAttachment): void => {
  if (
    !webBrowserPartitions.has(partition) &&
    partition !== ARTIFACT_BROWSER_PARTITION
  ) {
    throw new Error(`Browser guest partition is not allowed: ${partition}`);
  }

  // BrowserPanel mounts a blank guest before the user enters a URL.
  if (src === "" || src === "about:blank") return;

  if (partition === ARTIFACT_BROWSER_PARTITION) {
    assertArtifactPreviewUrl(src);
    return;
  }
  assertAgentBrowserUrl(src);
};

export const denyBrowserPermissionCheck = (): boolean => false;

export const denyBrowserPermissionRequest = (
  _webContents: unknown,
  _permission: string,
  callback: (permissionGranted: boolean) => void,
): void => callback(false);

export type ControlledWindowOpenHandler = (details: { url: string }) => {
  action: "deny";
};

/**
 * Chromium never creates the requested child window. A valid HTTP(S) target may
 * instead be handed to BrowserManager or navigated in the current controlled tab.
 */
export const createControlledWindowOpenHandler =
  (onAllowedUrl?: (url: string) => void): ControlledWindowOpenHandler =>
  ({ url }) => {
    try {
      const target = assertAgentBrowserUrl(url);
      onAllowedUrl?.(target.href);
    } catch {
      // Invalid and privileged schemes are intentionally ignored.
    }
    return { action: "deny" };
  };
