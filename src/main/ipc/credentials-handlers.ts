/**
 * IPC：credentials:* — 管理已存储的密钥(目前为 GitHub PAT)。
 *
 * Token 通过 `db/crypto.ts` 加密落盘(AES-256-GCM,密钥
 * 由 `app.getPath("userData")` 派生)。渲染进程在创建后永远拿不到
 * 原始 token —— 每次读取仅返回元数据。该实现
 * 与 `llm-config-handlers.ts` 中的 LLM 配置处理器保持一致。
 */

import { ipcMain } from "electron";

import {
  type CredentialKind,
  createCredential,
  deleteCredential,
  getCredentialToken,
  getLatestCredentialToken,
  listCredentials,
  recordCredentialTest,
  updateCredential,
} from "../db";

interface TestTokenResult {
  ok: boolean;
  login?: string;
  error?: string;
}

/** 用 token 请求 GET /user;成功即表示 PAT 有效。 */
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
    "credentials:update",
    async (
      _event,
      payload: {
        id: string;
        kind: CredentialKind;
        label: string;
        token?: string;
        scopes?: string[];
      },
    ) => {
      if (!payload?.id || typeof payload.id !== "string") {
        throw new Error("id is required");
      }
      if (!payload.label || typeof payload.label !== "string") {
        throw new Error("label is required");
      }
      const token =
        typeof payload.token === "string" && payload.token.trim()
          ? payload.token.trim()
          : undefined;
      return updateCredential({
        id: payload.id,
        kind: payload.kind,
        label: payload.label.trim(),
        token,
        scopes: payload.scopes ?? undefined,
      });
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
      // Tavily 和 Firecrawl 按请求计费 —— 跳过测试往返,
      // 直接信任用户输入的 key。接受任意非空字符串。
      if (payload.kind === "tavily_pat" || payload.kind === "firecrawl_pat") {
        return { ok: true };
      }
      const result =
        payload.kind === "gitlab_pat"
          ? await testGitlabToken(token, payload.host ?? "gitlab.com")
          : await testGithubToken(token);

      // M7:每次手动点击都持久化测试结果,使
      // CredentialsPanel 角标无需额外 IPC 即可保持同步。
      // 仅当用户测试的是已存储凭证(带 id)时才写入。
      // 对带显式 host 的 gitlab_pat,同时记住该 host,
      // 以便批量监控在下次启动时使用正确的 host。
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
 * 返回指定类型中最近创建的 token,若无则返回 null。
 * 供 agent 的 Web 工具(Tavily / Firecrawl)解析 API
 * key,无需为每个工具单独接线。委托给 `getLatestCredentialToken`
 * —— SQL 侧的 ORDER BY + LIMIT 1 比 listAll + 排序更省。
 */
export const tavilyCredentialResolver = async (): Promise<string | null> =>
  getLatestCredentialToken("tavily_pat");

export const firecrawlCredentialResolver = async (): Promise<string | null> =>
  getLatestCredentialToken("firecrawl_pat");
