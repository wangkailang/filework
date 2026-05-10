import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — capture every ipcMain.handle registration so we can invoke them.
// ---------------------------------------------------------------------------

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

const dbState = {
  credentials: [] as Array<{
    id: string;
    kind: "github_pat" | "gitlab_pat";
    label: string;
    scopes: string[] | null;
    createdAt: string;
    token: string;
    lastTestStatus?: "ok" | "error" | null;
    lastTestError?: string | null;
    lastTestedHost?: string | null;
  }>,
};

vi.mock("../../db", () => ({
  createCredential: ({
    kind,
    label,
    token,
    scopes,
  }: {
    kind: "github_pat";
    label: string;
    token: string;
    scopes?: string[] | null;
  }) => {
    const id = `cred-${dbState.credentials.length + 1}`;
    const createdAt = new Date().toISOString();
    dbState.credentials.push({
      id,
      kind,
      label,
      token,
      scopes: scopes ?? null,
      createdAt,
    });
    return { id, kind, label, scopes: scopes ?? null, createdAt };
  },
  listCredentials: () => dbState.credentials.map(({ token: _t, ...c }) => c),
  getCredentialToken: (id: string) => {
    const row = dbState.credentials.find((c) => c.id === id);
    if (!row) throw new Error(`Credential not found: ${id}`);
    return row.token;
  },
  deleteCredential: (id: string) => {
    dbState.credentials = dbState.credentials.filter((c) => c.id !== id);
  },
  recordCredentialTest: (input: {
    id: string;
    status: "ok" | "error";
    error?: string | null;
    host?: string | null;
  }) => {
    const row = dbState.credentials.find((c) => c.id === input.id);
    if (!row) return;
    row.lastTestStatus = input.status;
    row.lastTestError = input.error ?? null;
    if (input.host !== undefined) row.lastTestedHost = input.host;
  },
}));

import { registerCredentialsHandlers } from "../credentials-handlers";

describe("credentials handlers", () => {
  beforeEach(() => {
    handlers.clear();
    dbState.credentials.length = 0;
    registerCredentialsHandlers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("create + list never returns the raw token to the renderer", async () => {
    const create = handlers.get("credentials:create");
    if (!create) throw new Error("credentials:create not registered");
    const created = await create(null, {
      kind: "github_pat",
      label: "work",
      token: "ghp_TESTTOKEN",
    });
    expect(created).toMatchObject({
      kind: "github_pat",
      label: "work",
    });
    expect(JSON.stringify(created)).not.toContain("ghp_TESTTOKEN");

    const list = handlers.get("credentials:list");
    const all = (await list?.(null, undefined)) as unknown[];
    expect(all).toHaveLength(1);
    expect(JSON.stringify(all)).not.toContain("ghp_TESTTOKEN");
  });

  it("requires both label and token on create", async () => {
    const create = handlers.get("credentials:create");
    await expect(
      create?.(null, { kind: "github_pat", label: "x", token: "" }),
    ).rejects.toThrow(/token is required/);
    await expect(
      create?.(null, { kind: "github_pat", label: "", token: "x" }),
    ).rejects.toThrow(/label is required/);
  });

  it("delete removes the credential", async () => {
    const create = handlers.get("credentials:create");
    const del = handlers.get("credentials:delete");
    const created = (await create?.(null, {
      kind: "github_pat",
      label: "x",
      token: "t",
    })) as { id: string };
    expect(dbState.credentials).toHaveLength(1);
    await del?.(null, { id: created.id });
    expect(dbState.credentials).toHaveLength(0);
  });

  it("test pings GitHub /user with the supplied token", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ login: "octocat" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const test = handlers.get("credentials:test");
    const result = (await test?.(null, { token: "ghp_xyz" })) as {
      ok: boolean;
      login?: string;
    };
    expect(result.ok).toBe(true);
    expect(result.login).toBe("octocat");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/user",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer ghp_xyz",
        }),
      }),
    );
  });

  it("test reports a friendly error when GitHub rejects the token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 401 })),
    );
    const test = handlers.get("credentials:test");
    const result = (await test?.(null, { token: "bad" })) as {
      ok: boolean;
      error?: string;
    };
    expect(result.ok).toBe(false);
    expect(result.error).toContain("401");
  });

  it("test resolves the token by id when no raw token is supplied", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ login: "u" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const create = handlers.get("credentials:create");
    const created = (await create?.(null, {
      kind: "github_pat",
      label: "x",
      token: "ghp_resolveme",
    })) as { id: string };

    const test = handlers.get("credentials:test");
    await test?.(null, { id: created.id });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/user",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer ghp_resolveme",
        }),
      }),
    );
  });

  it("create accepts gitlab_pat kind", async () => {
    const create = handlers.get("credentials:create");
    const created = (await create?.(null, {
      kind: "gitlab_pat",
      label: "self-hosted",
      token: "glpat-X",
    })) as { kind: string; label: string };
    expect(created.kind).toBe("gitlab_pat");
    expect(created.label).toBe("self-hosted");
  });

  it("test pings GitLab /api/v4/user when kind=gitlab_pat with custom host", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ username: "alice" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const test = handlers.get("credentials:test");
    const result = (await test?.(null, {
      token: "glpat-X",
      kind: "gitlab_pat",
      host: "gitlab.example.com",
    })) as { ok: boolean; login?: string };

    expect(result.ok).toBe(true);
    expect(result.login).toBe("alice");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://gitlab.example.com/api/v4/user",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer glpat-X",
        }),
      }),
    );
  });

  it("test defaults to gitlab.com when kind=gitlab_pat without host", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ username: "u" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const test = handlers.get("credentials:test");
    await test?.(null, { token: "glpat-X", kind: "gitlab_pat" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://gitlab.com/api/v4/user",
      expect.anything(),
    );
  });
});
