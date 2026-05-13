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

const { createMock } = vi.hoisted(() => ({
  createMock: vi.fn(async (_ref: unknown, _deps: unknown) => ({
    root: "/tmp/fake-gl-clone",
    id: "gitlab:gitlab.com:acme/app@main",
  })),
}));

vi.mock("../../core/workspace/gitlab-workspace", () => ({
  GitLabWorkspace: { create: createMock },
}));

import { registerGitLabHandlers } from "../gitlab-handlers";

describe("gitlab handlers", () => {
  beforeEach(() => {
    handlers.clear();
    createMock.mockClear();
    registerGitLabHandlers({
      resolveToken: async () => "glpat-TEST",
      cacheDir: "/tmp/cache/gitlab",
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("listProjects paginates GET /projects?membership=true and shapes the response", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify(
            Array.from({ length: 100 }, (_, i) => ({
              path_with_namespace: `acme/p-${i}`,
              path: `p-${i}`,
              namespace: { full_path: "acme" },
              default_branch: "main",
              visibility: "private",
              description: null,
              last_activity_at: "2026-05-01T00:00:00Z",
            })),
          ),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              path_with_namespace: "acme/sub/last",
              path: "last",
              namespace: { full_path: "acme/sub" },
              default_branch: "develop",
              visibility: "internal",
              description: "desc",
              last_activity_at: "2026-05-01T00:00:00Z",
            },
          ]),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const list = handlers.get("gitlab:listProjects");
    const result = (await list?.(null, {
      credentialId: "cred-1",
      host: "gitlab.com",
    })) as Array<{
      fullPath: string;
      defaultBranch: string;
      visibility: string;
    }>;

    expect(result).toHaveLength(101);
    expect(result[100].fullPath).toBe("acme/sub/last");
    expect(result[100].defaultBranch).toBe("develop");

    const firstUrl = (fetchMock.mock.calls[0] as unknown as [string])[0];
    expect(firstUrl).toContain("https://gitlab.com/api/v4/projects");
    expect(firstUrl).toContain("membership=true");
    expect(firstUrl).toContain("per_page=100");
    expect(firstUrl).toContain("page=1");
  });

  it("listBranches encodes namespace/project as the project id", async () => {
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

    const listBranches = handlers.get("gitlab:listBranches");
    const result = (await listBranches?.(null, {
      credentialId: "cred-1",
      host: "gitlab.example.com",
      namespace: "acme/sub",
      project: "app",
    })) as Array<{ name: string; protected: boolean }>;

    expect(result).toEqual([
      { name: "main", protected: true },
      { name: "dev", protected: false },
    ]);
    const url = (fetchMock.mock.calls[0] as unknown as [string])[0];
    expect(url).toBe(
      "https://gitlab.example.com/api/v4/projects/acme%2Fsub%2Fapp/repository/branches?per_page=100",
    );
  });

  it("cloneRepo delegates to GitLabWorkspace.create with the right ref", async () => {
    const clone = handlers.get("gitlab:cloneRepo");
    const result = (await clone?.(null, {
      credentialId: "cred-1",
      host: "gitlab.example.com",
      namespace: "acme/sub",
      project: "app",
      ref: "main",
    })) as { root: string; id: string };

    expect(result).toEqual({
      root: "/tmp/fake-gl-clone",
      id: "gitlab:gitlab.com:acme/app@main",
    });
    expect(createMock).toHaveBeenCalledWith(
      {
        kind: "gitlab",
        host: "gitlab.example.com",
        namespace: "acme/sub",
        project: "app",
        ref: "main",
        credentialId: "cred-1",
      },
      expect.objectContaining({ cacheDir: "/tmp/cache/gitlab" }),
    );
  });

  it("fetchRepo forces a refresh by passing freshnessTtlMs:0", async () => {
    const fetchHandler = handlers.get("gitlab:fetchRepo");
    await fetchHandler?.(null, {
      credentialId: "cred-1",
      host: "gitlab.com",
      namespace: "acme",
      project: "app",
      ref: "main",
    });
    expect(createMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ freshnessTtlMs: 0 }),
    );
  });

  it("strips https:// scheme and trailing slash from host before calling the API or cloning", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("[]", { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ name: "main", protected: true }]), {
          status: 200,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const list = handlers.get("gitlab:listProjects");
    await list?.(null, {
      credentialId: "cred-1",
      host: "  https://gitlab.example.com/  ",
    });
    expect(
      (fetchMock.mock.calls[0] as unknown as [string])[0].startsWith(
        "https://gitlab.example.com/api/v4/projects",
      ),
    ).toBe(true);

    const listBranches = handlers.get("gitlab:listBranches");
    await listBranches?.(null, {
      credentialId: "cred-1",
      host: "HTTPS://gitlab.example.com",
      namespace: "acme",
      project: "app",
    });
    expect((fetchMock.mock.calls[1] as unknown as [string])[0]).toBe(
      "https://gitlab.example.com/api/v4/projects/acme%2Fapp/repository/branches?per_page=100",
    );

    const clone = handlers.get("gitlab:cloneRepo");
    await clone?.(null, {
      credentialId: "cred-1",
      host: "https://gitlab.example.com/",
      namespace: "acme",
      project: "app",
      ref: "main",
    });
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({ host: "gitlab.example.com" }),
      expect.anything(),
    );
  });

  it("propagates GitLab error payloads as readable errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("denied", { status: 403 })),
    );
    const list = handlers.get("gitlab:listProjects");
    await expect(
      list?.(null, { credentialId: "cred-1", host: "gitlab.com" }),
    ).rejects.toThrow(/403/);
  });
});
