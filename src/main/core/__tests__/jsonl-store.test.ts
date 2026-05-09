import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { JsonlSessionStore } from "../session/jsonl-store";
import type { MessagePart } from "../session/message-parts";
import { workspaceKey } from "../session/workspace-key";

describe("JsonlSessionStore", () => {
  let rootDir: string;
  let store: JsonlSessionStore;

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "fw-jsonl-"));
    store = new JsonlSessionStore(rootDir);
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  describe("createSession + listSessions", () => {
    it("creates a session and lists it back", async () => {
      const ws = "/some/workspace";
      const session = await store.createSession(ws, "First chat");
      expect(session.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(session.title).toBe("First chat");
      expect(session.workspacePath).toBe(ws);

      const list = await store.listSessions(ws);
      expect(list).toHaveLength(1);
      expect(list[0].id).toBe(session.id);
      expect(list[0].title).toBe("First chat");
    });

    it("defaults the title to 新对话", async () => {
      const session = await store.createSession("/ws");
      expect(session.title).toBe("新对话");
    });

    it("isolates sessions per workspace via the hashed key", async () => {
      const a = await store.createSession("/ws/a", "A");
      const b = await store.createSession("/ws/b", "B");
      const aList = await store.listSessions("/ws/a");
      const bList = await store.listSessions("/ws/b");
      expect(aList.map((s) => s.id)).toEqual([a.id]);
      expect(bList.map((s) => s.id)).toEqual([b.id]);
      expect(workspaceKey("/ws/a")).not.toBe(workspaceKey("/ws/b"));
    });

    it("listSessions returns sessions sorted desc by updatedAt", async () => {
      const s1 = await store.createSession("/ws", "first");
      await new Promise((r) => setTimeout(r, 5));
      const s2 = await store.createSession("/ws", "second");
      const list = await store.listSessions("/ws");
      expect(list[0].id).toBe(s2.id);
      expect(list[1].id).toBe(s1.id);
    });

    it("does NOT expose forkFromSessionId / forkFromMessageId in IPC shape", async () => {
      const src = await store.createSession("/ws", "Source");
      await store.saveMessages(src.id, "/ws", [
        {
          id: "m1",
          sessionId: src.id,
          role: "user",
          content: "hi",
          timestamp: "2026-05-09T22:00:00.000Z",
        },
      ]);
      await store.forkSession(src.id, "m1");
      const list = await store.listSessions("/ws");
      for (const s of list) {
        expect(s).not.toHaveProperty("forkFromSessionId");
        expect(s).not.toHaveProperty("forkFromMessageId");
      }
    });
  });

  describe("updateSession", () => {
    it("renames the title and bumps updatedAt", async () => {
      const session = await store.createSession("/ws", "Old");
      await new Promise((r) => setTimeout(r, 5));
      await store.updateSession(session.id, { title: "New" });
      const [reloaded] = await store.listSessions("/ws");
      expect(reloaded.title).toBe("New");
      expect(reloaded.updatedAt > session.updatedAt).toBe(true);
    });

    it("is a no-op for unknown sessionId", async () => {
      await expect(
        store.updateSession("does-not-exist", { title: "x" }),
      ).resolves.toBeUndefined();
    });
  });

  describe("saveMessages + getMessages", () => {
    it("round-trips messages with all 6 MessagePart variants", async () => {
      const session = await store.createSession("/ws");
      const parts: MessagePart[] = [
        { type: "text", text: "hello" },
        {
          type: "tool",
          toolCallId: "c1",
          toolName: "readFile",
          args: { path: "/etc/hosts" },
          result: "...",
          state: "output-available",
        },
        {
          type: "plan",
          plan: { id: "p1", goal: "G", steps: [], status: "draft" },
        },
        { type: "error", message: "boom", errorType: "rate_limit" },
        {
          type: "usage",
          inputTokens: 10,
          outputTokens: 20,
          totalTokens: 30,
          modelId: "x",
          provider: "y",
        },
        { type: "clarification", question: "Which dir?", options: ["a", "b"] },
      ];
      await store.saveMessages(session.id, "/ws", [
        {
          id: "m1",
          sessionId: session.id,
          role: "assistant",
          content: "ok",
          timestamp: "2026-05-09T22:00:00.000Z",
          parts,
        },
      ]);

      const messages = await store.getMessages(session.id);
      expect(messages).toHaveLength(1);
      expect(messages[0].parts).toEqual(parts);
    });

    it("getMessages returns [] for unknown sessionId", async () => {
      const messages = await store.getMessages("nope");
      expect(messages).toEqual([]);
    });

    it("saveMessages fully replaces previous messages", async () => {
      const s = await store.createSession("/ws");
      await store.saveMessages(s.id, "/ws", [
        {
          id: "m1",
          sessionId: s.id,
          role: "user",
          content: "first",
          timestamp: "2026-05-09T22:00:00.000Z",
        },
        {
          id: "m2",
          sessionId: s.id,
          role: "assistant",
          content: "reply",
          timestamp: "2026-05-09T22:00:01.000Z",
        },
      ]);
      await store.saveMessages(s.id, "/ws", [
        {
          id: "m3",
          sessionId: s.id,
          role: "user",
          content: "second",
          timestamp: "2026-05-09T22:01:00.000Z",
        },
      ]);
      const messages = await store.getMessages(s.id);
      expect(messages.map((m) => m.id)).toEqual(["m3"]);
    });

    it("messages come back sorted by timestamp", async () => {
      const s = await store.createSession("/ws");
      await store.saveMessages(s.id, "/ws", [
        {
          id: "z",
          sessionId: s.id,
          role: "user",
          content: "later",
          timestamp: "2026-05-09T23:00:00.000Z",
        },
        {
          id: "a",
          sessionId: s.id,
          role: "assistant",
          content: "earlier",
          timestamp: "2026-05-09T22:00:00.000Z",
        },
      ]);
      const messages = await store.getMessages(s.id);
      expect(messages.map((m) => m.id)).toEqual(["a", "z"]);
    });
  });

  describe("deleteSession", () => {
    it("removes the file and the session disappears from the list", async () => {
      const s = await store.createSession("/ws");
      await store.deleteSession(s.id);
      const list = await store.listSessions("/ws");
      expect(list).toHaveLength(0);

      const wsDir = path.join(rootDir, workspaceKey("/ws"));
      const files = await readdir(wsDir).catch(() => []);
      expect(files.find((f) => f.startsWith(s.id))).toBeUndefined();
    });

    it("is a no-op for unknown sessionId", async () => {
      await expect(store.deleteSession("nope")).resolves.toBeUndefined();
    });
  });

  describe("forkSession", () => {
    it("copies messages 0..forkIdx with new UUIDs and records lineage on disk", async () => {
      const src = await store.createSession("/ws", "Source");
      const messages = [
        {
          id: "m1",
          sessionId: src.id,
          role: "user" as const,
          content: "a",
          timestamp: "2026-05-09T22:00:00.000Z",
        },
        {
          id: "m2",
          sessionId: src.id,
          role: "assistant" as const,
          content: "b",
          timestamp: "2026-05-09T22:00:01.000Z",
        },
        {
          id: "m3",
          sessionId: src.id,
          role: "user" as const,
          content: "c",
          timestamp: "2026-05-09T22:00:02.000Z",
        },
      ];
      await store.saveMessages(src.id, "/ws", messages);

      const forked = await store.forkSession(src.id, "m2");
      expect(forked.title).toBe("Source (分支)");

      const forkedMessages = await store.getMessages(forked.id);
      expect(forkedMessages).toHaveLength(2);
      expect(forkedMessages.map((m) => m.content)).toEqual(["a", "b"]);
      for (const fm of forkedMessages) {
        expect(["m1", "m2", "m3"]).not.toContain(fm.id);
      }

      // Verify lineage is stored on disk (read raw).
      const wsDir = path.join(rootDir, workspaceKey("/ws"));
      const files = await readdir(wsDir);
      const forkedFile = files.find((f) => f.startsWith(forked.id));
      const raw = await readFile(path.join(wsDir, forkedFile ?? ""), "utf8");
      const sessionLine = JSON.parse(raw.split("\n")[0]);
      expect(sessionLine.forkFromSessionId).toBe(src.id);
      expect(sessionLine.forkFromMessageId).toBe("m2");
    });

    it("throws when forkPoint message is missing", async () => {
      const src = await store.createSession("/ws");
      await store.saveMessages(src.id, "/ws", [
        {
          id: "m1",
          sessionId: src.id,
          role: "user",
          content: "x",
          timestamp: "2026-05-09T22:00:00.000Z",
        },
      ]);
      await expect(store.forkSession(src.id, "missing")).rejects.toThrow(
        /分叉点消息不存在/,
      );
    });
  });

  describe("atomic write + crash recovery", () => {
    it("ignores stale .tmp orphans at next read", async () => {
      const s = await store.createSession("/ws");
      const wsDir = path.join(rootDir, workspaceKey("/ws"));
      await writeFile(
        path.join(wsDir, `${s.id}.jsonl.tmp`),
        "garbage that never got renamed",
      );
      const list = await store.listSessions("/ws");
      expect(list.map((x) => x.id)).toEqual([s.id]);
    });

    it("cleans .tmp orphans on the lazy-index pass", async () => {
      const s = await store.createSession("/ws");
      const wsDir = path.join(rootDir, workspaceKey("/ws"));
      const tmpPath = path.join(wsDir, `${s.id}.jsonl.tmp`);
      await writeFile(tmpPath, "stale");
      // Fresh store instance to trigger ensureIndex anew.
      const fresh = new JsonlSessionStore(rootDir);
      await fresh.getMessages(s.id);
      const filesAfter = await readdir(wsDir);
      expect(filesAfter).not.toContain(`${s.id}.jsonl.tmp`);
    });
  });
});
