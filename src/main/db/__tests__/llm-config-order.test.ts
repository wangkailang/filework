import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let userDataPath = "";

const dbMock = vi.hoisted(() => {
  const state = {
    orderedByUpdatedAtDesc: false,
    rows: [
      {
        id: "older",
        name: "older config",
        provider: "custom" as const,
        apiKey: null,
        baseUrl: "http://localhost:1234/v1",
        model: "older-model",
        modality: "chat" as const,
        isDefault: false,
        createdAt: "2026-01-01T00:01:00.000Z",
        updatedAt: "2026-01-01T00:01:00.000Z",
      },
      {
        id: "newer",
        name: "newer config",
        provider: "custom" as const,
        apiKey: null,
        baseUrl: "http://localhost:5678/v1",
        model: "newer-model",
        modality: "chat" as const,
        isDefault: false,
        createdAt: "2026-01-01T00:02:00.000Z",
        updatedAt: "2026-01-01T00:02:00.000Z",
      },
    ],
  };

  const query = {
    orderBy: vi.fn(() => {
      state.orderedByUpdatedAtDesc = true;
      return query;
    }),
    where: vi.fn(() => catalogQuery),
    all: vi.fn(() =>
      state.orderedByUpdatedAtDesc ? [...state.rows].reverse() : state.rows,
    ),
  };

  const catalogQuery = {
    all: vi.fn(() => []),
  };

  const select = vi.fn(() => ({
    from: vi.fn(() => query),
  }));

  return { catalogQuery, query, select, state };
});

class FakeDatabase {
  pragma() {
    return [];
  }

  exec() {}

  prepare() {
    return {
      all: () => [],
      get: () => undefined,
    };
  }

  transaction(fn: () => void) {
    return fn;
  }
}

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn(() => userDataPath),
  },
}));

vi.mock("better-sqlite3", () => ({
  default: FakeDatabase,
}));

vi.mock("drizzle-orm/better-sqlite3", () => ({
  drizzle: vi.fn(() => ({
    select: dbMock.select,
  })),
}));

describe("LLM config ordering", () => {
  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), "filework-llm-config-"));
    dbMock.state.orderedByUpdatedAtDesc = false;
    dbMock.catalogQuery.all.mockClear();
    dbMock.query.orderBy.mockClear();
    dbMock.query.where.mockClear();
    dbMock.query.all.mockClear();
    dbMock.select.mockClear();
  });

  afterEach(() => {
    rmSync(userDataPath, { force: true, recursive: true });
    vi.resetModules();
  });

  it("returns the most recently updated configs first", async () => {
    const { getLlmConfigs, initDatabase } = await import("../index");

    await initDatabase();

    expect(getLlmConfigs().map((config) => config.id)).toEqual([
      "newer",
      "older",
    ]);
    expect(dbMock.query.orderBy).toHaveBeenCalledOnce();
  });
});
