export type McpOAuthCredentialsStore = "auto" | "database" | "keychain";
export type McpOAuthEffectiveCredentialsStore = "database" | "keychain";

export interface RawMcpOAuthSettings {
  credentialsStore?: string | null;
  callbackHost?: string | null;
  callbackPort?: string | number | null;
  callbackPath?: string | null;
}

export interface ResolvedMcpOAuthSettings {
  credentialsStore: McpOAuthCredentialsStore;
  effectiveCredentialsStore: McpOAuthEffectiveCredentialsStore;
  callbackHost: string;
  callbackPort: number;
  callbackPath: string;
}

const DEFAULT_CALLBACK_HOST = "127.0.0.1";
const DEFAULT_CALLBACK_PORT = 0;
const DEFAULT_CALLBACK_PATH = "/callback";

const normalizeCredentialsStore = (
  value: string | null | undefined,
): McpOAuthCredentialsStore => {
  if (value === "database" || value === "keychain") return value;
  return "auto";
};

const normalizeCallbackHost = (value: string | null | undefined): string => {
  const host = value?.trim().toLowerCase();
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
    return host;
  }
  return DEFAULT_CALLBACK_HOST;
};

const normalizeCallbackPort = (
  value: string | number | null | undefined,
): number => {
  const raw = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(raw) || raw < 0 || raw > 65_535) {
    return DEFAULT_CALLBACK_PORT;
  }
  return raw;
};

const normalizeCallbackPath = (value: string | null | undefined): string => {
  const trimmed = value?.trim();
  if (!trimmed) return DEFAULT_CALLBACK_PATH;
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  const pathOnly = withSlash.split(/[?#]/, 1)[0];
  return pathOnly === "/" ? DEFAULT_CALLBACK_PATH : pathOnly;
};

export const resolveMcpOAuthSettings = (
  raw: RawMcpOAuthSettings,
  options: { safeStorageAvailable: boolean },
): ResolvedMcpOAuthSettings => {
  const credentialsStore = normalizeCredentialsStore(raw.credentialsStore);
  const effectiveCredentialsStore: McpOAuthEffectiveCredentialsStore =
    credentialsStore === "database" ||
    (credentialsStore === "keychain" && !options.safeStorageAvailable) ||
    (credentialsStore === "auto" && !options.safeStorageAvailable)
      ? "database"
      : "keychain";

  return {
    credentialsStore,
    effectiveCredentialsStore,
    callbackHost: normalizeCallbackHost(raw.callbackHost),
    callbackPort: normalizeCallbackPort(raw.callbackPort),
    callbackPath: normalizeCallbackPath(raw.callbackPath),
  };
};

export const buildMcpOAuthRedirectUrl = (
  settings: Pick<
    ResolvedMcpOAuthSettings,
    "callbackHost" | "callbackPort" | "callbackPath"
  >,
  actualPort?: number,
): string => {
  const url = new URL("http://127.0.0.1");
  url.hostname = settings.callbackHost;
  const port = actualPort ?? settings.callbackPort;
  if (port > 0) url.port = String(port);
  url.pathname = settings.callbackPath;
  return url.toString();
};
