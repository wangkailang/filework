export type BrowserSurfaceKind = "web" | "artifact";

export type BrowserNavigationCommand = "back" | "forward" | "reload" | "stop";

export type BrowserGrant = "once" | "always" | "blocked";

export type BrowserRisk = "read" | "input" | "external-effect" | "forbidden";

export interface BrowserTabState {
  id: string;
  kind: BrowserSurfaceKind;
  url: string;
  title: string;
  faviconUrl?: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  active: boolean;
  crashed: boolean;
}

export interface BrowserViewportBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserTabsStateEvent {
  type: "state";
  tabs: BrowserTabState[];
  activeTabId: string | null;
}

export type BrowserDownloadStatus =
  | "progressing"
  | "completed"
  | "cancelled"
  | "interrupted";

export interface BrowserDownloadState {
  id: string;
  filename: string;
  status: BrowserDownloadStatus;
  receivedBytes: number;
  totalBytes: number;
  savePath?: string;
}

export interface BrowserDownloadStateEvent {
  type: "download";
  download: BrowserDownloadState;
}

export type BrowserStateEvent =
  | BrowserTabsStateEvent
  | BrowserDownloadStateEvent;

export interface BrowserElementRef {
  ref: string;
  role?: string;
  tag: string;
  name?: string;
  value?: string;
  href?: string;
  inputType?: string;
  autocomplete?: string;
  buttonType?: string;
  inForm?: boolean;
  formMethod?: string;
  formAction?: string;
  rect: { x: number; y: number; width: number; height: number };
  visible: boolean;
}

export interface BrowserApprovalRequest {
  requestId: string;
  taskId: string;
  kind: "origin" | "sensitive-action" | "developer-access";
  origin: string;
  action?: {
    type: string;
    target: string;
    risk: BrowserRisk;
  };
}

export type BrowserApprovalDecision =
  | "allow-once"
  | "always-allow"
  | "block"
  | "approve-once"
  | "deny";

export interface BrowserObservation {
  tabId: string;
  navigationId: string;
  snapshotId: string;
  url: string;
  title: string;
  viewport: {
    width: number;
    height: number;
    deviceScaleFactor: number;
  };
  text: string;
  elements: BrowserElementRef[];
  elementsTruncated: boolean;
  stateHash: string;
  captureId?: string;
  actionResult?: {
    outcome: "changed" | "unchanged" | "navigated";
    settleReason: "navigation" | "dom-quiet" | "timeout" | "cancelled";
    previousSnapshotId: string;
  };
  sourceTrust: "untrusted-web";
}

export type BrowserAction =
  | { type: "click"; ref: string }
  | { type: "type"; ref: string; text: string; clear?: boolean }
  | { type: "press"; key: string; ref?: string }
  | { type: "scroll"; deltaX?: number; deltaY?: number };

export interface BrowserActionRequest {
  tabId: string;
  navigationId: string;
  snapshotId: string;
  action: BrowserAction;
}

export interface BrowserSettings {
  sharedSurfaceEnabled: boolean;
  allowedOrigins: string[];
  blockedOrigins: string[];
  developerModeEnabled: boolean;
  downloadAskEveryTime: boolean;
  downloadDirectory: string;
}

export type BrowserSettingsPatch = Partial<BrowserSettings>;

export const BROWSER_SETTING_STORAGE_KEYS = {
  sharedSurfaceEnabled: "browser.sharedSurface.enabled",
  allowedOrigins: "browser.allowedOrigins",
  blockedOrigins: "browser.blockedOrigins",
  developerModeEnabled: "browser.developerMode.enabled",
  downloadAskEveryTime: "browser.download.askEveryTime",
  downloadDirectory: "browser.download.directory",
} as const satisfies Record<keyof BrowserSettings, string>;

export type BrowserSettingName = keyof typeof BROWSER_SETTING_STORAGE_KEYS;

export const DEFAULT_BROWSER_SETTINGS: BrowserSettings = {
  sharedSurfaceEnabled: false,
  allowedOrigins: [],
  blockedOrigins: [],
  developerModeEnabled: false,
  downloadAskEveryTime: true,
  downloadDirectory: "",
};

const BROWSER_SETTING_NAMES = Object.keys(
  BROWSER_SETTING_STORAGE_KEYS,
) as BrowserSettingName[];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

export const parseBrowserUrl = (raw: string): URL => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Invalid browser URL");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Browser URL scheme is not allowed: ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new Error("Browser URL credentials are not allowed");
  }

  return url;
};

const parseBrowserOrigin = (raw: unknown): string => {
  if (typeof raw !== "string") {
    throw new Error("Browser origin must be a string");
  }

  let url: URL;
  try {
    url = parseBrowserUrl(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "invalid URL";
    throw new Error(`Invalid browser origin: ${detail}`);
  }

  if (
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    raw !== url.origin
  ) {
    throw new Error(`Browser origin must be an exact origin: ${raw}`);
  }

  return url.origin;
};

const parseOriginList = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    throw new Error("Browser origin setting must be an array");
  }
  return [...new Set(value.map(parseBrowserOrigin))];
};

const isBrowserAction = (value: unknown): value is BrowserAction => {
  if (!isRecord(value) || typeof value.type !== "string") return false;

  switch (value.type) {
    case "click":
      return isNonEmptyString(value.ref);
    case "type":
      return isNonEmptyString(value.ref) && typeof value.text === "string";
    case "press":
      return (
        isNonEmptyString(value.key) &&
        (value.ref === undefined || isNonEmptyString(value.ref))
      );
    case "scroll":
      return (
        (value.deltaX === undefined || isFiniteNumber(value.deltaX)) &&
        (value.deltaY === undefined || isFiniteNumber(value.deltaY)) &&
        (value.deltaX !== undefined || value.deltaY !== undefined)
      );
    default:
      return false;
  }
};

export const isBrowserActionRequest = (
  value: unknown,
): value is BrowserActionRequest =>
  isRecord(value) &&
  isNonEmptyString(value.tabId) &&
  isNonEmptyString(value.navigationId) &&
  isNonEmptyString(value.snapshotId) &&
  isBrowserAction(value.action);

export const parseBrowserSettingsPatch = (
  value: unknown,
): BrowserSettingsPatch => {
  if (!isRecord(value)) {
    throw new Error("Browser settings patch must be an object");
  }

  const result: BrowserSettingsPatch = {};
  for (const [rawKey, rawValue] of Object.entries(value)) {
    if (!BROWSER_SETTING_NAMES.includes(rawKey as BrowserSettingName)) {
      throw new Error(`Unknown browser setting: ${rawKey}`);
    }

    const key = rawKey as BrowserSettingName;
    switch (key) {
      case "sharedSurfaceEnabled":
      case "developerModeEnabled":
      case "downloadAskEveryTime":
        if (typeof rawValue !== "boolean") {
          throw new Error(`Browser setting ${key} must be a boolean`);
        }
        result[key] = rawValue;
        break;
      case "allowedOrigins":
      case "blockedOrigins":
        result[key] = parseOriginList(rawValue);
        break;
      case "downloadDirectory":
        if (typeof rawValue !== "string") {
          throw new Error(`Browser setting ${key} must be a string`);
        }
        result[key] = rawValue;
        break;
    }
  }

  return result;
};

export const encodeBrowserSetting = (
  key: BrowserSettingName,
  value: BrowserSettings[BrowserSettingName],
): string => {
  const parsed = parseBrowserSettingsPatch({ [key]: value });
  const normalizedValue = parsed[key];
  return typeof normalizedValue === "string"
    ? normalizedValue
    : JSON.stringify(normalizedValue);
};

const decodePersistedValue = (
  key: BrowserSettingName,
  value: string | null,
): BrowserSettings[BrowserSettingName] => {
  if (value === null) return DEFAULT_BROWSER_SETTINGS[key];

  try {
    const decoded =
      key === "downloadDirectory"
        ? value
        : key === "allowedOrigins" || key === "blockedOrigins"
          ? JSON.parse(value)
          : value === "true"
            ? true
            : value === "false"
              ? false
              : undefined;
    if (decoded === undefined) return DEFAULT_BROWSER_SETTINGS[key];
    return (
      parseBrowserSettingsPatch({ [key]: decoded })[key] ??
      DEFAULT_BROWSER_SETTINGS[key]
    );
  } catch {
    return DEFAULT_BROWSER_SETTINGS[key];
  }
};

export const decodeBrowserSettings = (
  readValue: (storageKey: string) => string | null,
): BrowserSettings => ({
  sharedSurfaceEnabled: decodePersistedValue(
    "sharedSurfaceEnabled",
    readValue(BROWSER_SETTING_STORAGE_KEYS.sharedSurfaceEnabled),
  ) as boolean,
  allowedOrigins: decodePersistedValue(
    "allowedOrigins",
    readValue(BROWSER_SETTING_STORAGE_KEYS.allowedOrigins),
  ) as string[],
  blockedOrigins: decodePersistedValue(
    "blockedOrigins",
    readValue(BROWSER_SETTING_STORAGE_KEYS.blockedOrigins),
  ) as string[],
  developerModeEnabled: decodePersistedValue(
    "developerModeEnabled",
    readValue(BROWSER_SETTING_STORAGE_KEYS.developerModeEnabled),
  ) as boolean,
  downloadAskEveryTime: decodePersistedValue(
    "downloadAskEveryTime",
    readValue(BROWSER_SETTING_STORAGE_KEYS.downloadAskEveryTime),
  ) as boolean,
  downloadDirectory: decodePersistedValue(
    "downloadDirectory",
    readValue(BROWSER_SETTING_STORAGE_KEYS.downloadDirectory),
  ) as string,
});
