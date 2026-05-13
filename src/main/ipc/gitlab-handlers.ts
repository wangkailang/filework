/**
 * IPC: gitlab:* — talk to the GitLab v4 REST API + manage local clones.
 *
 * Mirrors `github-handlers.ts` for the GitLab provider. Uses raw `fetch`
 * (Node 18+); auth header is `Authorization: Bearer <pat>` which works
 * for GitLab Personal Access Tokens and OAuth tokens alike.
 *
 * Cloning is delegated to `GitLabWorkspace.create()` which handles the
 * shallow clone, freshness check, and re-auth on each entry.
 */

import { ipcMain } from "electron";

import { normalizeGitLabHost } from "../core/workspace/git-credentials";
import {
  type GitLabRef,
  GitLabWorkspace,
  type GitLabWorkspaceDeps,
} from "../core/workspace/gitlab-workspace";

export interface GitLabProjectSummary {
  /** "namespace/project". */
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
  // 200 projects covers the vast majority of users; later PRs paginate fully.
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
  /** Decrypts a stored credential id into the underlying token. */
  resolveToken: (credentialId: string) => Promise<string>;
  /** Same root passed to GitLabWorkspace.create(). */
  cacheDir: string;
  /** GIT_ASKPASS helper script (M7). */
  askpassPath?: string;
  /**
   * Optional per-request proxy-aware fetch. Defaults to global `fetch`,
   * which routes through the EnvHttpProxyAgent installed by
   * `proxy-bootstrap.ts`. Production wires this to `proxy-fetch.ts` so
   * each request consults `session.resolveProxy(url)` and bypasses the
   * proxy for hosts the user's PAC rules route DIRECT.
   */
  fetchFn?: typeof fetch;
}

export const registerGitLabHandlers = (deps: GitLabHandlerDeps) => {
  // Resolve fetch on each call so test harnesses can `vi.stubGlobal("fetch", …)`
  // after this handler is registered. Capturing at registration time would
  // snapshot the original global before the stub lands.
  const fetchImpl: typeof fetch = (input, init) =>
    (deps.fetchFn ?? fetch)(input, init);
  const wsDeps: GitLabWorkspaceDeps = {
    resolveToken: deps.resolveToken,
    cacheDir: deps.cacheDir,
    askpassPath: deps.askpassPath,
    fetchFn: fetchImpl,
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
        /** Branch the workspace was opened at — used to build the ref. */
        ref: string;
        /** Target branch to switch to. */
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
