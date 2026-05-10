import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface FakeCredential {
  id: string;
  kind: "github_pat" | "gitlab_pat";
  label: string;
  scopes: string[] | null;
  createdAt: string;
  lastTestedAt: string | null;
  testStatus: "unknown" | "ok" | "error" | null;
  lastTestError: string | null;
  lastTestedHost: string | null;
  /** Test-only — the resolved token. */
  _token: string;
}

const dbState = {
  credentials: [] as FakeCredential[],
  recordedTests: [] as Array<{
    id: string;
    status: "ok" | "error";
    error?: string | null;
    host?: string | null;
  }>,
};

vi.mock("../../db", () => ({
  listCredentials: () => dbState.credentials.map(({ _token: _t, ...c }) => c),
  getCredentialToken: (id: string) => {
    const row = dbState.credentials.find((c) => c.id === id);
    if (!row) throw new Error(`not found: ${id}`);
    return row._token;
  },
  recordCredentialTest: (input: {
    id: string;
    status: "ok" | "error";
    error?: string | null;
    host?: string | null;
  }) => {
    dbState.recordedTests.push(input);
    const row = dbState.credentials.find((c) => c.id === input.id);
    if (row) {
      row.testStatus = input.status;
      row.lastTestError = input.error ?? null;
      row.lastTestedAt = new Date().toISOString();
      if (input.host !== undefined) row.lastTestedHost = input.host;
    }
  },
}));

import { batchTestCredentials, isStale } from "../credentials-monitor";

const baseCred = (overrides: Partial<FakeCredential> = {}): FakeCredential => ({
  id: "c1",
  kind: "github_pat",
  label: "tok",
  scopes: null,
  createdAt: "2026-05-01T00:00:00Z",
  lastTestedAt: null,
  testStatus: null,
  lastTestError: null,
  lastTestedHost: null,
  _token: "ghp_TESTTOKEN",
  ...overrides,
});

describe("isStale", () => {
  const NOW = new Date("2026-05-10T00:00:00Z").getTime();

  it("returns true when never tested", () => {
    expect(isStale({ lastTestedAt: null, testStatus: null }, NOW)).toBe(true);
  });

  it("returns true when last test was > 24h ago", () => {
    expect(
      isStale({ lastTestedAt: "2026-05-08T00:00:00Z", testStatus: "ok" }, NOW),
    ).toBe(true);
  });

  it("returns false when tested within debounce window", () => {
    expect(
      isStale({ lastTestedAt: "2026-05-09T20:00:00Z", testStatus: "ok" }, NOW),
    ).toBe(false);
  });

  it("returns true when timestamp is unparseable", () => {
    expect(isStale({ lastTestedAt: "garbage", testStatus: "ok" }, NOW)).toBe(
      true,
    );
  });
});

describe("batchTestCredentials", () => {
  beforeEach(() => {
    dbState.credentials = [];
    dbState.recordedTests = [];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("tests a github credential and persists ok status", async () => {
    dbState.credentials.push(baseCred({ kind: "github_pat" }));
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ login: "u" }), { status: 200 }),
      ),
    );
    const out = await batchTestCredentials();
    expect(out).toEqual({ tested: 1, skipped: 0 });
    expect(dbState.recordedTests).toEqual([
      { id: "c1", status: "ok", error: null, host: undefined },
    ]);
  });

  it("records error status + message on auth failure", async () => {
    dbState.credentials.push(baseCred());
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 401 })),
    );
    await batchTestCredentials();
    expect(dbState.recordedTests[0]).toEqual({
      id: "c1",
      status: "error",
      error: "GitHub responded 401",
      host: undefined,
    });
  });

  it("skips credentials tested within the 24h window", async () => {
    dbState.credentials.push(
      baseCred({
        lastTestedAt: new Date(Date.now() - 60_000).toISOString(),
        testStatus: "ok",
      }),
    );
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const out = await batchTestCredentials();
    expect(out).toEqual({ tested: 0, skipped: 1 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses lastTestedHost for gitlab_pat re-test", async () => {
    dbState.credentials.push(
      baseCred({
        id: "c2",
        kind: "gitlab_pat",
        _token: "glpat-X",
        lastTestedHost: "gitlab.example.com",
      }),
    );
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ username: "alice" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await batchTestCredentials();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://gitlab.example.com/api/v4/user",
      expect.anything(),
    );
  });

  it("defaults to gitlab.com when no lastTestedHost is recorded", async () => {
    dbState.credentials.push(
      baseCred({ id: "c3", kind: "gitlab_pat", _token: "glpat-Y" }),
    );
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ username: "u" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await batchTestCredentials();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://gitlab.com/api/v4/user",
      expect.anything(),
    );
  });

  it("isolates failures — one bad credential doesn't stop the others", async () => {
    dbState.credentials.push(
      baseCred({ id: "c1" }),
      baseCred({ id: "c2", _token: "" }),
    );
    let callCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        callCount++;
        if (callCount === 1) throw new Error("network down");
        return new Response(JSON.stringify({ login: "u" }), { status: 200 });
      }),
    );
    const out = await batchTestCredentials();
    // Both attempted; first surfaced as error result, second ok.
    expect(out.tested).toBe(2);
  });
});
