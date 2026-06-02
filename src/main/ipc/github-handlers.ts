/**
 * IPC: github:* —与 GitHub REST API 交互 + 管理本地克隆。
 *
 * 使用原生 `fetch` API（Node 18+）以避免引入 @octokit/rest。
 * 经 GitHub PAT 认证的客户端有 5000 次/小时的速率限制;由渲染进程
 * 负责缓存仓库列表并避免轮询。
 *
 * 克隆委托给 `GitHubWorkspace.create()`,它负责浅克隆、新鲜度检查,
 * 以及每次进入时的重新认证。
 */

import { ipcMain } from "electron";

import type { ProxyResolver } from "../core/workspace/git-proxy-env";
import {
  type GitHubRef,
  GitHubWorkspace,
  type GitHubWorkspaceDeps,
} from "../core/workspace/github-workspace";
import { getCredentialToken } from "../db";

export interface GitHubRepoSummary {
  fullName: string;
  owner: string;
  name: string;
  defaultBranch: string;
  private: boolean;
  description: string | null;
  updatedAt: string;
}

export interface GitHubBranchSummary {
  name: string;
  protected: boolean;
}

const ghHeaders = (token: string): Record<string, string> => ({
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${token}`,
  "X-GitHub-Api-Version": "2022-11-28",
});

const fetchJson = async <T>(
  url: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<T> => {
  const res = await fetchImpl(url, { headers: ghHeaders(token) });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub ${res.status} for ${url}: ${text.slice(0, 200)}`);
  }
  return (await res.json()) as T;
};

interface RawRepo {
  full_name: string;
  name: string;
  owner: { login: string };
  default_branch: string;
  private: boolean;
  description: string | null;
  updated_at: string;
}

interface RawBranch {
  name: string;
  protected: boolean;
}

const listAllRepos = async (
  token: string,
  fetchImpl: typeof fetch,
): Promise<GitHubRepoSummary[]> => {
  // 200 个仓库可覆盖绝大多数用户;后续 PR 会实现完整分页。
  const out: GitHubRepoSummary[] = [];
  for (let page = 1; page <= 2; page++) {
    const url = `https://api.github.com/user/repos?per_page=100&sort=pushed&page=${page}`;
    const repos = await fetchJson<RawRepo[]>(url, token, fetchImpl);
    for (const r of repos) {
      out.push({
        fullName: r.full_name,
        owner: r.owner.login,
        name: r.name,
        defaultBranch: r.default_branch,
        private: r.private,
        description: r.description,
        updatedAt: r.updated_at,
      });
    }
    if (repos.length < 100) break;
  }
  return out;
};

const listBranches = async (
  owner: string,
  repo: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<GitHubBranchSummary[]> => {
  const url = `https://api.github.com/repos/${owner}/${repo}/branches?per_page=100`;
  const branches = await fetchJson<RawBranch[]>(url, token, fetchImpl);
  return branches.map((b) => ({ name: b.name, protected: b.protected }));
};

export interface GitHubHandlerDeps {
  /** 将存储的凭证 id 解密为底层 token。 */
  resolveToken: (credentialId: string) => Promise<string>;
  /** 与传给 GitHubWorkspace.create() 的根目录相同。 */
  cacheDir: string;
  /** GIT_ASKPASS 辅助脚本（M7）。 */
  askpassPath?: string;
  /**
   * 可选的逐请求代理感知 fetch。默认使用全局 `fetch`。生产环境将其
   * 接入 `proxy-fetch.ts`,使每个请求查询 `session.resolveProxy(url)`,
   * 而非继承来自 `proxy-bootstrap.ts` 的一次性 `EnvHttpProxyAgent`。
   */
  fetchFn?: typeof fetch;
  /**
   * 用于派生的 `git` 子进程的逐主机代理解析器（参见
   * `core/workspace/git-proxy-env.ts`）。生产环境将其接入
   * `session.defaultSession.resolveProxy`;测试中可留空。
   */
  resolveProxy?: ProxyResolver;
}

export const registerGitHubHandlers = (deps: GitHubHandlerDeps) => {
  // 每次调用时再解析 fetch,以便测试框架可在该 handler 注册之后执行
  // `vi.stubGlobal("fetch", …)`。若在注册时捕获,会在 stub 生效前就
  // 快照了原始全局对象。
  const fetchImpl: typeof fetch = (input, init) =>
    (deps.fetchFn ?? fetch)(input, init);
  const wsDeps: GitHubWorkspaceDeps = {
    resolveToken: deps.resolveToken,
    cacheDir: deps.cacheDir,
    askpassPath: deps.askpassPath,
    resolveProxy: deps.resolveProxy,
  };

  ipcMain.handle(
    "github:listRepos",
    async (_event, payload: { credentialId: string }) => {
      const token = await deps.resolveToken(payload.credentialId);
      return listAllRepos(token, fetchImpl);
    },
  );

  ipcMain.handle(
    "github:listBranches",
    async (
      _event,
      payload: { credentialId: string; owner: string; repo: string },
    ) => {
      const token = await deps.resolveToken(payload.credentialId);
      return listBranches(payload.owner, payload.repo, token, fetchImpl);
    },
  );

  ipcMain.handle(
    "github:cloneRepo",
    async (
      _event,
      payload: {
        credentialId: string;
        owner: string;
        repo: string;
        ref: string;
      },
    ) => {
      const ref: GitHubRef = {
        kind: "github",
        owner: payload.owner,
        repo: payload.repo,
        ref: payload.ref,
        credentialId: payload.credentialId,
      };
      const ws = await GitHubWorkspace.create(ref, wsDeps);
      return { root: ws.root, id: ws.id };
    },
  );

  ipcMain.handle(
    "github:checkoutBranch",
    async (
      _event,
      payload: {
        credentialId: string;
        owner: string;
        repo: string;
        /** 工作区打开时所在的分支 —— 用于构建 ref。 */
        ref: string;
        /** 要切换到的目标分支。 */
        branch: string;
      },
    ) => {
      const ref: GitHubRef = {
        kind: "github",
        owner: payload.owner,
        repo: payload.repo,
        ref: payload.ref,
        credentialId: payload.credentialId,
      };
      const ws = await GitHubWorkspace.create(ref, wsDeps);
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
    "github:fetchRepo",
    async (
      _event,
      payload: {
        credentialId: string;
        owner: string;
        repo: string;
        ref: string;
      },
    ) => {
      const ref: GitHubRef = {
        kind: "github",
        owner: payload.owner,
        repo: payload.repo,
        ref: payload.ref,
        credentialId: payload.credentialId,
      };
      // 通过传入 TTL=0 强制刷新;ensureClone 会重新拉取。
      const ws = await GitHubWorkspace.create(ref, {
        ...wsDeps,
        freshnessTtlMs: 0,
      });
      return { root: ws.root, id: ws.id };
    },
  );
};

/** 由 `getCredentialToken` 支撑的默认 `resolveToken`。 */
export const credentialResolver = async (
  credentialId: string,
): Promise<string> => getCredentialToken(credentialId);
