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

const fetchJson = async <T>(url: string, token: string): Promise<T> => {
  const res = await fetch(url, { headers: glHeaders(token) });
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
): Promise<GitLabProjectSummary[]> => {
  // 200 projects covers the vast majority of users; later PRs paginate fully.
  const out: GitLabProjectSummary[] = [];
  for (let page = 1; page <= 2; page++) {
    const url =
      `${apiBase(host)}/projects?membership=true&per_page=100` +
      `&order_by=last_activity_at&sort=desc&page=${page}`;
    const projects = await fetchJson<RawProject[]>(url, token);
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
): Promise<GitLabBranchSummary[]> => {
  const projectId = encodeURIComponent(`${namespace}/${project}`);
  const url = `${apiBase(host)}/projects/${projectId}/repository/branches?per_page=100`;
  const branches = await fetchJson<RawBranch[]>(url, token);
  return branches.map((b) => ({ name: b.name, protected: b.protected }));
};

export interface GitLabHandlerDeps {
  /** Decrypts a stored credential id into the underlying token. */
  resolveToken: (credentialId: string) => Promise<string>;
  /** Same root passed to GitLabWorkspace.create(). */
  cacheDir: string;
  /** GIT_ASKPASS helper script (M7). */
  askpassPath?: string;
}

export const registerGitLabHandlers = (deps: GitLabHandlerDeps) => {
  const wsDeps: GitLabWorkspaceDeps = {
    resolveToken: deps.resolveToken,
    cacheDir: deps.cacheDir,
    askpassPath: deps.askpassPath,
  };

  ipcMain.handle(
    "gitlab:listProjects",
    async (_event, payload: { credentialId: string; host: string }) => {
      const token = await deps.resolveToken(payload.credentialId);
      return listAllProjects(payload.host, token);
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
        payload.host,
        payload.namespace,
        payload.project,
        token,
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
        host: payload.host,
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
        host: payload.host,
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
