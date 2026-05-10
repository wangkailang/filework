import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const handlers = new Map<
  string,
  (event: unknown, payload: unknown) => unknown
>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: (
      channel: string,
      fn: (event: unknown, payload: unknown) => unknown,
    ) => {
      handlers.set(channel, fn);
    },
  },
}));

vi.mock("../../db", () => ({
  getCredentialToken: () => "ghp_TESTTOKEN",
}));

const { createMock } = vi.hoisted(() => ({
  createMock: vi.fn(async (_ref: unknown, _deps: unknown) => ({
    root: "/tmp/fake-clone",
    id: "github:acme/app@main",
  })),
}));

vi.mock("../../core/workspace/github-workspace", () => ({
  GitHubWorkspace: { create: createMock },
}));

import { registerGitHubHandlers } from "../github-handlers";

describe("github handlers", () => {
  beforeEach(() => {
    handlers.clear();
    createMock.mockClear();
    registerGitHubHandlers({
      resolveToken: async () => "ghp_TESTTOKEN",
      cacheDir: "/tmp/cache/github",
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("listRepos paginates GET /user/repos and shapes the response", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify(
            Array.from({ length: 100 }, (_, i) => ({
              full_name: `acme/repo-${i}`,
              name: `repo-${i}`,
              owner: { login: "acme" },
              default_branch: "main",
              private: false,
              description: null,
              updated_at: "2026-05-09T00:00:00Z",
            })),
          ),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              full_name: "acme/repo-100",
              name: "repo-100",
              owner: { login: "acme" },
              default_branch: "dev",
              private: true,
              description: "desc",
              updated_at: "2026-05-09T00:00:00Z",
            },
          ]),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const list = handlers.get("github:listRepos");
    const result = (await list?.(null, { credentialId: "cred-1" })) as Array<{
      fullName: string;
      defaultBranch: string;
      private: boolean;
    }>;

    expect(result).toHaveLength(101);
    expect(result[0].fullName).toBe("acme/repo-0");
    expect(result[100].fullName).toBe("acme/repo-100");
    expect(result[100].private).toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://api.github.com/user/repos?per_page=100&sort=pushed&page=1",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer ghp_TESTTOKEN",
          "X-GitHub-Api-Version": "2022-11-28",
        }),
      }),
    );
  });

  it("listBranches calls /repos/<owner>/<repo>/branches and maps shape", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify([
            { name: "main", protected: true },
            { name: "dev", protected: false },
          ]),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const listBranches = handlers.get("github:listBranches");
    const result = (await listBranches?.(null, {
      credentialId: "cred-1",
      owner: "acme",
      repo: "app",
    })) as Array<{ name: string; protected: boolean }>;

    expect(result).toEqual([
      { name: "main", protected: true },
      { name: "dev", protected: false },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/acme/app/branches?per_page=100",
      expect.anything(),
    );
  });

  it("cloneRepo delegates to GitHubWorkspace.create with the right ref", async () => {
    const clone = handlers.get("github:cloneRepo");
    const result = (await clone?.(null, {
      credentialId: "cred-1",
      owner: "acme",
      repo: "app",
      ref: "main",
    })) as { root: string; id: string };

    expect(result).toEqual({
      root: "/tmp/fake-clone",
      id: "github:acme/app@main",
    });
    expect(createMock).toHaveBeenCalledWith(
      {
        kind: "github",
        owner: "acme",
        repo: "app",
        ref: "main",
        credentialId: "cred-1",
      },
      expect.objectContaining({
        cacheDir: "/tmp/cache/github",
      }),
    );
  });

  it("fetchRepo forces a refresh by passing freshnessTtlMs:0", async () => {
    const fetch = handlers.get("github:fetchRepo");
    await fetch?.(null, {
      credentialId: "cred-1",
      owner: "acme",
      repo: "app",
      ref: "main",
    });
    expect(createMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ freshnessTtlMs: 0 }),
    );
  });

  it("propagates GitHub error payloads as readable errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("rate limited", { status: 429 })),
    );
    const list = handlers.get("github:listRepos");
    await expect(list?.(null, { credentialId: "cred-1" })).rejects.toThrow(
      /429/,
    );
  });
});
