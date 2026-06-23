import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let userDataPath = "";

const sqliteMock = vi.hoisted(() => {
  const state = {
    createdTriageIndex: false,
    createdRetryIndex: false,
    execCalls: [] as string[],
    hasNextRetryAt: false,
    hasTriageStatus: false,
    migrated: false,
    widenedCopilotProvider: false,
  };

  class FakeDatabase {
    pragma(sql: string) {
      if (sql.includes("mcp_servers")) {
        return [
          { name: "auth_type" },
          { name: "oauth_scopes" },
          { name: "oauth_client_id" },
          { name: "oauth_client_secret" },
        ];
      }
      if (sql.includes("tasks")) {
        return [
          { name: "input_tokens" },
          { name: "output_tokens" },
          { name: "total_tokens" },
          { name: "model_id" },
          { name: "provider" },
        ];
      }
      if (sql.includes("llm_configs")) return [{ name: "modality" }];
      if (sql.includes("recent_workspaces")) {
        return [{ name: "kind" }, { name: "metadata" }];
      }
      return undefined;
    }

    exec(sql: string) {
      state.execCalls.push(sql);
      if (sql.includes("CREATE TABLE automation_runs_new")) {
        state.hasTriageStatus = true;
        state.hasNextRetryAt = true;
        state.migrated = true;
      }
      if (
        sql.includes("CREATE TABLE llm_configs_new") &&
        sql.includes("github-copilot")
      ) {
        state.widenedCopilotProvider = true;
      }
      if (
        sql.includes("ALTER TABLE automation_runs ADD COLUMN next_retry_at")
      ) {
        state.hasNextRetryAt = true;
      }
      if (sql.includes("idx_automation_runs_triage")) {
        if (!state.hasTriageStatus) {
          throw new Error("SqliteError: no such column: triage_status");
        }
        state.createdTriageIndex = true;
      }
      if (sql.includes("idx_automation_runs_retry")) {
        if (!state.hasNextRetryAt) {
          throw new Error("SqliteError: no such column: next_retry_at");
        }
        state.createdRetryIndex = true;
      }
    }

    prepare(sql: string) {
      return {
        all: () => [],
        get: () => {
          if (sql.includes("automation_runs")) {
            return {
              sql: state.hasTriageStatus
                ? `CREATE TABLE automation_runs (status TEXT CHECK(status IN ('needs_action')), triage_status TEXT, needs_action_reason TEXT, chat_session_id TEXT, assistant_message_id TEXT, task_id TEXT${state.hasNextRetryAt ? ", next_retry_at TEXT" : ""})`
                : "CREATE TABLE automation_runs (status TEXT CHECK(status IN ('queued','running','succeeded','failed','canceled')))",
            };
          }
          if (sql.includes("credentials")) {
            return {
              sql: "CREATE TABLE credentials (kind TEXT CHECK(kind IN ('github_pat','gitlab_pat','tavily_pat','firecrawl_pat')))",
            };
          }
          if (sql.includes("mcp_servers")) {
            return {
              sql: "CREATE TABLE mcp_servers (auth_type TEXT CHECK(auth_type IN ('auto','none','oauth')))",
            };
          }
          if (sql.includes("llm_configs")) {
            return {
              sql: "CREATE TABLE llm_configs (provider TEXT CHECK(provider IN ('openai','minimax','xiaomi')), modality TEXT)",
            };
          }
          return undefined;
        },
      };
    }

    transaction(fn: () => void) {
      return fn;
    }
  }

  return { FakeDatabase, state };
});

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn(() => userDataPath),
  },
}));

vi.mock("better-sqlite3", () => ({
  default: sqliteMock.FakeDatabase,
}));

vi.mock("drizzle-orm/better-sqlite3", () => ({
  drizzle: vi.fn(() => ({
    select: () => ({
      from: () => ({
        all: () => [{ id: "existing-config" }],
      }),
    }),
  })),
}));

describe("automation run migrations", () => {
  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), "filework-db-"));
    sqliteMock.state.createdTriageIndex = false;
    sqliteMock.state.createdRetryIndex = false;
    sqliteMock.state.execCalls = [];
    sqliteMock.state.hasNextRetryAt = false;
    sqliteMock.state.hasTriageStatus = false;
    sqliteMock.state.migrated = false;
    sqliteMock.state.widenedCopilotProvider = false;
  });

  afterEach(() => {
    rmSync(userDataPath, { force: true, recursive: true });
    vi.resetModules();
  });

  it("migrates old automation_runs tables before creating triage indexes", async () => {
    const { initDatabase } = await import("../index");

    await expect(initDatabase()).resolves.toBeUndefined();

    expect(sqliteMock.state.migrated).toBe(true);
    expect(sqliteMock.state.createdTriageIndex).toBe(true);
  });

  it("adds next_retry_at before creating retry indexes on triage-migrated tables", async () => {
    sqliteMock.state.hasTriageStatus = true;

    const { initDatabase } = await import("../index");

    await expect(initDatabase()).resolves.toBeUndefined();

    expect(sqliteMock.state.migrated).toBe(false);
    expect(sqliteMock.state.hasNextRetryAt).toBe(true);
    expect(sqliteMock.state.createdRetryIndex).toBe(true);
  });

  it("widens old llm_configs provider checks for GitHub Copilot", async () => {
    const { initDatabase } = await import("../index");

    await expect(initDatabase()).resolves.toBeUndefined();

    expect(sqliteMock.state.widenedCopilotProvider).toBe(true);
  });
});
