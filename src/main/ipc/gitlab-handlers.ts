/**
 * IPC: gitlab:* —与 GitLab v4 REST API 交互 + 管理本地克隆。
 *
 * 针对 GitLab provider 对 `github-handlers.ts` 的镜像实现。使用原生
 * `fetch`（Node 18+）;认证头为 `Authorization: Bearer <pat>`,对
 * GitLab 个人访问令牌和 OAuth 令牌均适用。
 *
 * 克隆委托给 `GitLabWorkspace.create()`,它负责浅克隆、新鲜度检查,
 * 以及每次进入时的重新认证。
 */

import { ipcMain } from "electron";

import { normalizeGitLabHost } from "../core/workspace/git-credentials";
import type { ProxyResolver } from "../core/workspace/git-proxy-env";
import {
  type GitLabRef,
  GitLabWorkspace,
  type GitLabWorkspaceDeps,
} from "../core/workspace/gitlab-workspace";

export interface GitLabProjectSummary {
  /** "namespace/project"。 */
  fullPath: string;
  namespace: string;
  project: string;
  defaultBranch: string;
  visibility: "private" | "internal" | "public";
  description: string | null;
  lastActivityAt: string;
}

export interface GitLabBranchSummary {
  name: string;
  protected: boolean;
}

const glHeaders = (token: string): Record<string, string> => ({
  Accept: "application/json",
  Authorization: `Bearer ${token}`,
});

const fetchJson = async <T>(
  url: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<T> => {
  const res = await fetchImpl(url, { headers: glHeaders(token) });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitLab ${res.status} for ${url}: ${text.slice(0, 200)}`);
  }
  return (await res.json()) as T;
};

interface RawProject {
  path_with_namespace: string;
  path: string;
  namespace: { full_path: string };
  default_branch: string | null;
  visibility: "private" | "internal" | "public";
  description: string | null;
  last_activity_at: string;
}

interface RawBranch {
  name: string;
  protected: boolean;
}

const apiBase = (host: string): string => `https://${host}/api/v4`;

const listAllProjects = async (
  host: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<GitLabProjectSummary[]> => {
  // 200 个项目可覆盖绝大多数用户;后续 PR 会实现完整分页。
  const out: GitLabProjectSummary[] = [];
  for (let page = 1; page <= 2; page++) {
    const url =
      `${apiBase(host)}/projects?membership=true&per_page=100` +
      `&order_by=last_activity_at&sort=desc&page=${page}`;
    const projects = await fetchJson<RawProject[]>(url, token, fetchImpl);
    for (const p of projects) {
      out.push({
        fullPath: p.path_with_namespace,
        namespace: p.namespace.full_path,
        project: p.path,
        defaultBranch: p.default_branch ?? "main",
        visibility: p.visibility,
        description: p.description,
        lastActivityAt: p.last_activity_at,
      });
    }
    if (projects.length < 100) break;
  }
  return out;
};

const listBranches = async (
  host: string,
  namespace: string,
  project: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<GitLabBranchSummary[]> => {
  const projectId = encodeURIComponent(`${namespace}/${project}`);
  const url = `${apiBase(host)}/projects/${projectId}/repository/branches?per_page=100`;
  const branches = await fetchJson<RawBranch[]>(url, token, fetchImpl);
  return branches.map((b) => ({ name: b.name, protected: b.protected }));
};

export interface GitLabHandlerDeps {
  /** 将存储的凭证 id 解密为底层 token。 */
  resolveToken: (credentialId: string) => Promise<string>;
  /** 与传给 GitLabWorkspace.create() 的根目录相同。 */
  cacheDir: string;
  /** GIT_ASKPASS 辅助脚本（M7）。 */
  askpassPath?: string;
  /**
   * 可选的逐请求代理感知 fetch。默认使用全局 `fetch`,它会经由
   * `proxy-bootstrap.ts` 安装的 EnvHttpProxyAgent 路由。生产环境将其
   * 接入 `proxy-fetch.ts`,使每个请求查询 `session.resolveProxy(url)`,
   * 并对用户 PAC 规则判定为 DIRECT 的主机绕过代理。
   */
  fetchFn?: typeof fetch;
  /**
   * 用于派生的 `git` 子进程的逐主机代理解析器（参见
   * `core/workspace/git-proxy-env.ts`）。生产环境将其接入
   * `session.defaultSession.resolveProxy`;测试中可留空。
   */
  resolveProxy?: ProxyResolver;
}

export const registerGitLabHandlers = (deps: GitLabHandlerDeps) => {
  // 每次调用时再解析 fetch,以便测试框架可在该 handler 注册之后执行
  // `vi.stubGlobal("fetch", …)`。若在注册时捕获,会在 stub 生效前就
  // 快照了原始全局对象。
  const fetchImpl: typeof fetch = (input, init) =>
    (deps.fetchFn ?? fetch)(input, init);
  const wsDeps: GitLabWorkspaceDeps = {
    resolveToken: deps.resolveToken,
    cacheDir: deps.cacheDir,
    askpassPath: deps.askpassPath,
    resolveProxy: deps.resolveProxy,
  };

  ipcMain.handle(
    "gitlab:listProjects",
    async (_event, payload: { credentialId: string; host: string }) => {
      const token = await deps.resolveToken(payload.credentialId);
      return listAllProjects(
        normalizeGitLabHost(payload.host),
        token,
        fetchImpl,
      );
    },
  );

  ipcMain.handle(
    "gitlab:listBranches",
    async (
      _event,
      payload: {
        credentialId: string;
        host: string;
        namespace: string;
        project: string;
      },
    ) => {
      const token = await deps.resolveToken(payload.credentialId);
      return listBranches(
        normalizeGitLabHost(payload.host),
        payload.namespace,
        payload.project,
        token,
        fetchImpl,
      );
    },
  );

  ipcMain.handle(
    "gitlab:cloneRepo",
    async (
      _event,
      payload: {
        credentialId: string;
        host: string;
        namespace: string;
        project: string;
        ref: string;
      },
    ) => {
      const ref: GitLabRef = {
        kind: "gitlab",
        host: normalizeGitLabHost(payload.host),
        namespace: payload.namespace,
        project: payload.project,
        ref: payload.ref,
        credentialId: payload.credentialId,
      };
      const ws = await GitLabWorkspace.create(ref, wsDeps);
      return { root: ws.root, id: ws.id };
    },
  );

  ipcMain.handle(
    "gitlab:checkoutBranch",
    async (
      _event,
      payload: {
        credentialId: string;
        host: string;
        namespace: string;
        project: string;
        /** 工作区打开时所在的分支 —— 用于构建 ref。 */
        ref: string;
        /** 要切换到的目标分支。 */
        branch: string;
      },
    ) => {
      const ref: GitLabRef = {
        kind: "gitlab",
        host: normalizeGitLabHost(payload.host),
        namespace: payload.namespace,
        project: payload.project,
        ref: payload.ref,
        credentialId: payload.credentialId,
      };
      const ws = await GitLabWorkspace.create(ref, wsDeps);
      if (!ws.scm?.checkoutBranch) {
        throw new Error("checkoutBranch unsupported on this workspace");
      }
      const result = await ws.scm.checkoutBranch({ branch: payload.branch });
      return {
        ...result,
        root: ws.root,
        id: ws.id,
      };
    },
  );

  ipcMain.handle(
    "gitlab:fetchRepo",
    async (
      _event,
      payload: {
        credentialId: string;
        host: string;
        namespace: string;
        project: string;
        ref: string;
      },
    ) => {
      const ref: GitLabRef = {
        kind: "gitlab",
        host: normalizeGitLabHost(payload.host),
        namespace: payload.namespace,
        project: payload.project,
        ref: payload.ref,
        credentialId: payload.credentialId,
      };
      const ws = await GitLabWorkspace.create(ref, {
        ...wsDeps,
        freshnessTtlMs: 0,
      });
      return { root: ws.root, id: ws.id };
    },
  );
};
