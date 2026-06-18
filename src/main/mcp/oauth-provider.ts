import { randomUUID } from "node:crypto";
import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

import type { McpOAuthSession } from "./types";

export interface McpOAuthSessionStore {
  get(): McpOAuthSession;
  set(session: McpOAuthSession): void | Promise<void>;
}

export interface CreateMcpOAuthProviderOptions {
  serverId: string;
  serverName: string;
  serverUrl: string;
  redirectUrl: string;
  scopes: string[];
  oauthClientId?: string | null;
  oauthClientSecret?: string | null;
  sessionStore: McpOAuthSessionStore;
  interactive: boolean;
  openExternal: (url: string) => void | Promise<void>;
}

const asObject = <T>(value: unknown): T | undefined =>
  value && typeof value === "object" ? (value as T) : undefined;

const mergeSession = async (
  store: McpOAuthSessionStore,
  patch: Partial<McpOAuthSession>,
) => {
  await store.set({ ...store.get(), ...patch });
};

export const createMcpOAuthProvider = ({
  serverName,
  redirectUrl,
  scopes,
  oauthClientId,
  oauthClientSecret,
  sessionStore,
  interactive,
  openExternal,
}: CreateMcpOAuthProviderOptions): OAuthClientProvider => {
  const configuredClient = oauthClientId
    ? ({
        client_id: oauthClientId,
        ...(oauthClientSecret ? { client_secret: oauthClientSecret } : {}),
      } satisfies OAuthClientInformationMixed)
    : undefined;

  return {
    redirectUrl,
    clientMetadata: {
      client_name: `Filework Desktop - ${serverName}`,
      redirect_uris: [redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      ...(scopes.length > 0 ? { scope: scopes.join(" ") } : {}),
    },
    async state() {
      const state = randomUUID();
      await mergeSession(sessionStore, { authorizationState: state });
      return state;
    },
    async clientInformation() {
      if (configuredClient) return configuredClient;
      return asObject<OAuthClientInformationMixed>(
        sessionStore.get().clientInformation,
      );
    },
    async saveClientInformation(clientInformation) {
      if (!configuredClient) {
        await mergeSession(sessionStore, { clientInformation });
      }
    },
    async tokens() {
      return asObject<OAuthTokens>(sessionStore.get().tokens);
    },
    async saveTokens(tokens) {
      await mergeSession(sessionStore, {
        authorizationState: undefined,
        authorizationUrl: undefined,
        tokens,
      });
    },
    async redirectToAuthorization(authorizationUrl) {
      await mergeSession(sessionStore, {
        authorizationUrl: authorizationUrl.toString(),
      });
      if (interactive) await openExternal(authorizationUrl.toString());
    },
    async saveCodeVerifier(codeVerifier) {
      await mergeSession(sessionStore, { codeVerifier });
    },
    async codeVerifier() {
      const codeVerifier = sessionStore.get().codeVerifier;
      if (!codeVerifier) throw new Error("Missing MCP OAuth code verifier");
      return codeVerifier;
    },
    async invalidateCredentials(scope) {
      const current = sessionStore.get();
      if (scope === "all") {
        await sessionStore.set({});
        return;
      }
      if (scope === "tokens") {
        await sessionStore.set({ ...current, tokens: undefined });
        return;
      }
      if (scope === "client") {
        await sessionStore.set({ ...current, clientInformation: undefined });
        return;
      }
      if (scope === "verifier") {
        await sessionStore.set({ ...current, codeVerifier: undefined });
        return;
      }
      if (scope === "discovery") {
        await sessionStore.set({ ...current, discoveryState: undefined });
      }
    },
    async saveDiscoveryState(discoveryState) {
      await mergeSession(sessionStore, { discoveryState });
    },
    async discoveryState() {
      return asObject<OAuthDiscoveryState>(sessionStore.get().discoveryState);
    },
  };
};
