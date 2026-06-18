import type {
  McpAuthErrorCode,
  McpOAuthSession,
  McpServer,
  McpServerStatus,
} from "./types";

export type McpAuthFailureStage =
  | "authorization"
  | "callback"
  | "callback_listener"
  | "connection"
  | "token_exchange";

const hasOAuthSessionTokens = (session?: McpOAuthSession): boolean => {
  const tokens = session?.tokens;
  return Boolean(
    tokens &&
      typeof tokens === "object" &&
      "access_token" in tokens &&
      typeof (tokens as { access_token?: unknown }).access_token === "string",
  );
};

const usesOAuth = (
  config: Pick<McpServer, "transport" | "authType">,
): boolean => config.transport === "http" && config.authType !== "none";

export const createMcpServerStatus = (
  config: Pick<McpServer, "id" | "transport" | "authType">,
  session?: McpOAuthSession,
): McpServerStatus => ({
  id: config.id,
  connected: false,
  connecting: false,
  toolCount: 0,
  lastError: null,
  lastConnectedAt: null,
  authStatus: usesOAuth(config)
    ? hasOAuthSessionTokens(session)
      ? "authenticated"
      : "unknown"
    : "not_applicable",
  authMessage: null,
  authErrorCode: null,
  authUrl: null,
});

export const markMcpAuthorizing = (status: McpServerStatus): void => {
  status.authStatus = "authorizing";
  status.authMessage = null;
  status.authErrorCode = null;
  status.authUrl = null;
};

export const markMcpAuthorized = (status: McpServerStatus): void => {
  status.authStatus = "authenticated";
  status.authMessage = null;
  status.authErrorCode = null;
  status.authUrl = null;
};

export const markMcpAuthRequired = (
  status: McpServerStatus,
  details: { message: string; authorizationUrl?: string | null },
): void => {
  status.authStatus = "needs_auth";
  status.authMessage = details.message;
  status.authErrorCode = null;
  status.authUrl = details.authorizationUrl ?? null;
};

const getErrorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

export const classifyMcpAuthError = (
  err: unknown,
  stage: McpAuthFailureStage = "authorization",
): McpAuthErrorCode => {
  const message = getErrorMessage(err).toLowerCase();
  if (message.includes("timed out waiting for mcp oauth callback")) {
    return "callback_timeout";
  }
  if (message.includes("oauth callback state did not match")) {
    return "state_mismatch";
  }
  if (message.includes("oauth callback failed")) return "callback_error";
  if (stage === "callback_listener") return "callback_listener_failed";
  if (stage === "callback") return "callback_error";
  if (stage === "token_exchange") return "token_exchange_failed";
  if (stage === "connection") return "connection_failed";
  return "authorization_failed";
};

export const markMcpAuthError = (
  status: McpServerStatus,
  message: string,
  details: {
    code?: McpAuthErrorCode;
    stage?: McpAuthFailureStage;
  } = {},
): void => {
  status.authStatus = "error";
  status.authMessage = message;
  status.authErrorCode =
    details.code ?? classifyMcpAuthError(message, details.stage);
  status.authUrl = null;
};

export const markMcpAuthorizationCleared = (status: McpServerStatus): void => {
  status.authStatus =
    status.authStatus === "not_applicable" ? "not_applicable" : "unknown";
  status.authMessage = null;
  status.authErrorCode = null;
  status.authUrl = null;
};
