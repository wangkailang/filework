/**
 * IPC: github:* — talk to the GitHub REST API + manage local clones.
 *
 * Uses the raw `fetch` API (Node 18+) to avoid pulling in @octokit/rest.
 * GitHub PAT-authenticated clients have a 5000 req/hr rate limit; the
 * renderer is responsible for caching repo lists and avoiding polling.
 *
 * Cloning is delegated to `GitHubWorkspace.create()` which handles the
 * shallow clone, freshness check, and re-auth on each entry.
 */

import { ipcMain } from "electron";

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

const fetchJson = async <T>(url: string, token: string): Promise<T> => {
  const res = await fetch(url, { headers: ghHeaders(token) });
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

const listAllRepos = async (token: string): Promise<GitHubRepoSummary[]> => {
  // 200 repos covers the vast majority of users; later PRs will paginate fully.
  const out: GitHubRepoSummary[] = [];
  for (let page = 1; page <= 2; page++) {
    const url = `https://api.github.com/user/repos?per_page=100&sort=pushed&page=${page}`;
    const repos = await fetchJson<RawRepo[]>(url, token);
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
): Promise<GitHubBranchSummary[]> => {
  const url = `https://api.github.com/repos/${owner}/${repo}/branches?per_page=100`;
  const branches = await fetchJson<RawBranch[]>(url, token);
  return branches.map((b) => ({ name: b.name, protected: b.protected }));
};

export interface GitHubHandlerDeps {
  /** Decrypts a stored credential id into the underlying token. */
  resolveToken: (credentialId: string) => Promise<string>;
  /** Same root passed to GitHubWorkspace.create(). */
  cacheDir: string;
}

export const registerGitHubHandlers = (deps: GitHubHandlerDeps) => {
  const wsDeps: GitHubWorkspaceDeps = {
    resolveToken: deps.resolveToken,
    cacheDir: deps.cacheDir,
  };

  ipcMain.handle(
    "github:listRepos",
    async (_event, payload: { credentialId: string }) => {
      const token = await deps.resolveToken(payload.credentialId);
      return listAllRepos(token);
    },
  );

  ipcMain.handle(
    "github:listBranches",
    async (
      _event,
      payload: { credentialId: string; owner: string; repo: string },
    ) => {
      const token = await deps.resolveToken(payload.credentialId);
      return listBranches(payload.owner, payload.repo, token);
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
      // Force a refresh by passing TTL=0; ensureClone will re-fetch.
      const ws = await GitHubWorkspace.create(ref, {
        ...wsDeps,
        freshnessTtlMs: 0,
      });
      return { root: ws.root, id: ws.id };
    },
  );
};

/** Default `resolveToken` backed by `getCredentialToken`. */
export const credentialResolver = async (
  credentialId: string,
): Promise<string> => getCredentialToken(credentialId);
