import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { JsonlSessionStore } from "../../core/session/jsonl-store";
import { workspaceKey } from "../../core/session/workspace-key";

// Mock the legacy SQLite chat exports — both the migration helper and the
// per-session reader must be controllable by the test.
const fakeSessions: Array<Record<string, unknown>> = [];
const fakeMessagesBySessionId = new Map<string, unknown[]>();

vi.mock("../index", () => ({
  getAllChatSessionsForMigration: () => fakeSessions,
  getChatHistory: (sessionId: string) =>
    fakeMessagesBySessionId.get(sessionId) ?? [],
}));

import { migrateChatToJsonl } from "../jsonl-migration";

describe("migrateChatToJsonl", () => {
  let rootDir: string;
  let store: JsonlSessionStore;

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "fw-migration-"));
    store = new JsonlSessionStore(rootDir);
    fakeSessions.length = 0;
    fakeMessagesBySessionId.clear();
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it("returns zero counts when there are no source sessions", async () => {
    const report = await migrateChatToJsonl(store);
    expect(report).toEqual({ migrated: 0, skipped: 0, errors: [] });
  });

  it("migrates a session with parts that come back as parsed objects", async () => {
    const sessionId = "s1";
    fakeSessions.push({
      id: sessionId,
      workspacePath: "/ws",
      title: "T",
      createdAt: "2026-05-09T22:00:00.000Z",
      updatedAt: "2026-05-09T22:00:00.000Z",
    });
    fakeMessagesBySessionId.set(sessionId, [
      {
        id: "m1",
        sessionId,
        role: "assistant",
        content: "hi",
        timestamp: "2026-05-09T22:00:00.000Z",
        // getChatHistory returns parts already parsed (db/index.ts:675).
        parts: [{ type: "text", text: "hi" }],
      },
    ]);

    const report = await migrateChatToJsonl(store);
    expect(report.migrated).toBe(1);
    expect(report.skipped).toBe(0);
    expect(report.errors).toEqual([]);

    // On-disk format must be JSON-native (not stringified strings).
    const wsDir = path.join(rootDir, workspaceKey("/ws"));
    const filePath = path.join(wsDir, `${sessionId}.jsonl`);
    const raw = await readFile(filePath, "utf8");
    const lines = raw
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines[0].kind).toBe("session");
    expect(lines[1].kind).toBe("message");
    expect(Array.isArray(lines[1].parts)).toBe(true);
    expect(lines[1].parts[0]).toEqual({ type: "text", text: "hi" });
  });

  it("is idempotent — running twice skips already-migrated sessions", async () => {
    fakeSessions.push({
      id: "a",
      workspacePath: "/ws",
      title: "A",
      createdAt: "2026-05-09T22:00:00.000Z",
      updatedAt: "2026-05-09T22:00:00.000Z",
    });
    fakeSessions.push({
      id: "b",
      workspacePath: "/ws",
      title: "B",
      createdAt: "2026-05-09T22:00:00.000Z",
      updatedAt: "2026-05-09T22:00:00.000Z",
    });
    fakeMessagesBySessionId.set("a", []);
    fakeMessagesBySessionId.set("b", []);

    const first = await migrateChatToJsonl(store);
    expect(first.migrated).toBe(2);
    expect(first.skipped).toBe(0);

    const second = await migrateChatToJsonl(store);
    expect(second.migrated).toBe(0);
    expect(second.skipped).toBe(2);
  });

  it("preserves forkFromSessionId / forkFromMessageId in the on-disk SessionLine", async () => {
    fakeSessions.push({
      id: "child",
      workspacePath: "/ws",
      title: "Child (分支)",
      createdAt: "2026-05-09T22:00:00.000Z",
      updatedAt: "2026-05-09T22:00:00.000Z",
      forkFromSessionId: "parent-id",
      forkFromMessageId: "fork-msg-id",
    });
    fakeMessagesBySessionId.set("child", []);

    await migrateChatToJsonl(store);

    const wsDir = path.join(rootDir, workspaceKey("/ws"));
    const raw = await readFile(path.join(wsDir, "child.jsonl"), "utf8");
    const sessionLine = JSON.parse(raw.split("\n")[0]);
    expect(sessionLine.forkFromSessionId).toBe("parent-id");
    expect(sessionLine.forkFromMessageId).toBe("fork-msg-id");
  });

  it("collects per-session errors without crashing the whole migration", async () => {
    fakeSessions.push({
      id: "ok",
      workspacePath: "/ws/ok",
      title: "ok",
      createdAt: "2026-05-09T22:00:00.000Z",
      updatedAt: "2026-05-09T22:00:00.000Z",
    });
    fakeSessions.push({
      // Missing workspacePath should not crash the run.
      id: "broken",
      workspacePath: undefined,
      title: "boom",
      createdAt: "2026-05-09T22:00:00.000Z",
      updatedAt: "2026-05-09T22:00:00.000Z",
    });
    fakeMessagesBySessionId.set("ok", []);
    fakeMessagesBySessionId.set("broken", []);

    const report = await migrateChatToJsonl(store);
    // The "ok" session must end up on disk regardless of "broken"'s fate.
    const wsDir = path.join(rootDir, workspaceKey("/ws/ok"));
    await expect(
      readFile(path.join(wsDir, "ok.jsonl"), "utf8"),
    ).resolves.toContain('"id":"ok"');
    expect(report.migrated).toBeGreaterThanOrEqual(1);
  });
});
