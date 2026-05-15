/**
 * IPC: credentials:* — manage stored secrets (currently GitHub PATs).
 *
 * Tokens are encrypted at rest via `db/crypto.ts` (AES-256-GCM, key
 * derived from `app.getPath("userData")`). The renderer never sees the
 * raw token after creation — every read returns metadata only. This
 * mirrors the LLM-config handler at `llm-config-handlers.ts`.
 */

import { ipcMain } from "electron";

import {
  type CredentialKind,
  createCredential,
  deleteCredential,
  getCredentialToken,
  listCredentials,
  recordCredentialTest,
} from "../db";

interface TestTokenResult {
  ok: boolean;
  login?: string;
  error?: string;
}

/** Hit GET /user with a token; success means the PAT is valid. */
const testGithubToken = async (token: string): Promise<TestTokenResult> => {
  try {
    const res = await fetch("https://api.github.com/user", {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!res.ok) {
      return { ok: false, error: `GitHub responded ${res.status}` };
    }
    const body = (await res.json()) as { login?: string };
    return { ok: true, login: body.login };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
};

const testGitlabToken = async (
  token: string,
  host: string,
): Promise<TestTokenResult> => {
  try {
    const res = await fetch(`https://${host}/api/v4/user`, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
    });
    if (!res.ok) {
      return { ok: false, error: `GitLab responded ${res.status}` };
    }
    const body = (await res.json()) as { username?: string };
    return { ok: true, login: body.username };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
};

export const registerCredentialsHandlers = () => {
  ipcMain.handle("credentials:list", async () => listCredentials());

  ipcMain.handle(
    "credentials:create",
    async (
      _event,
      payload: {
        kind: CredentialKind;
        label: string;
        token: string;
        scopes?: string[];
      },
    ) => {
      if (!payload?.token || typeof payload.token !== "string") {
        throw new Error("token is required");
      }
      if (!payload.label) {
        throw new Error("label is required");
      }
      return createCredential({
        kind: payload.kind,
        label: payload.label,
        token: payload.token,
        scopes: payload.scopes ?? null,
      });
    },
  );

  ipcMain.handle(
    "credentials:delete",
    async (_event, payload: { id: string }) => {
      deleteCredential(payload.id);
      return true;
    },
  );

  ipcMain.handle(
    "credentials:test",
    async (
      _event,
      payload: {
        id?: string;
        token?: string;
        kind?: CredentialKind;
        host?: string;
      },
    ): Promise<TestTokenResult> => {
      const token = payload.id ? getCredentialToken(payload.id) : payload.token;
      if (!token) return { ok: false, error: "Missing token or credential id" };
      // Tavily and Firecrawl charge per request — skip the test round-trip
      // and trust the user-entered key. Accept any non-empty string.
      if (payload.kind === "tavily_pat" || payload.kind === "firecrawl_pat") {
        return { ok: true };
      }
      const result =
        payload.kind === "gitlab_pat"
          ? await testGitlabToken(token, payload.host ?? "gitlab.com")
          : await testGithubToken(token);

      // M7: persist the test result on every manual click so the
      // CredentialsPanel badge stays in sync without a separate IPC.
      // Only writes when the user tested a stored credential (has id).
      // For gitlab_pat with an explicit host, also remember it so the
      // batch monitor uses the right host on next launch.
      if (payload.id) {
        recordCredentialTest({
          id: payload.id,
          status: result.ok ? "ok" : "error",
          error: result.ok ? null : (result.error ?? "Token invalid"),
          host:
            payload.kind === "gitlab_pat" && payload.host
              ? payload.host
              : undefined,
        });
      }
      return result;
    },
  );
};

/**
 * Returns the most recently created token of the given kind, or null
 * when no matching credential exists. Used by the agent's web tools
 * (Tavily / Firecrawl) to resolve API keys without per-tool wiring.
 */
const resolveLatestToken = (kind: CredentialKind): string | null => {
  const list = listCredentials().filter((c) => c.kind === kind);
  if (list.length === 0) return null;
  // Most recently created wins. listCredentials() may or may not be
  // sorted — sort defensively by createdAt desc.
  list.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return getCredentialToken(list[0].id);
};

export const tavilyCredentialResolver = async (): Promise<string | null> =>
  resolveLatestToken("tavily_pat");

export const firecrawlCredentialResolver = async (): Promise<string | null> =>
  resolveLatestToken("firecrawl_pat");
