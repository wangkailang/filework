/**
 * Tests for `buildAgentToolRegistry` — focused on the blocking
 * suspension contract of `askClarification`.
 *
 * The skill `allowed-tools` allow-list path is exercised implicitly by
 * other code paths; here we pin the askClarification behavior so a
 * regression can't re-introduce the non-blocking `{ asked: true }`
 * shortcut that let the model continue generating before the user
 * picked an option.
 */
import type { WebContents } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildAgentToolRegistry } from "../agent-tools";
import {
  drainClarificationResolver,
  drainClarificationsForTask,
  pendingClarifications,
} from "../ai-task-control";

// Belt-and-braces: keep the module-level Map clean between tests so a
// case that forgets to drain can't poison the next one.
afterEach(() => {
  pendingClarifications.clear();
});

describe("askClarification tool — blocks until user answers", () => {
  // The whole point of this fix: the tool must NOT resolve synchronously.
  // Without the pendingClarifications suspension, the model receives a
  // fake `{ asked: true }` immediately and keeps generating before the
  // user can pick an option. These tests pin the suspension contract.

  // ai-sdk normalizes execute to accept a typed args + context; for
  // shape testing we only care about the returned Promise.
  type ToolLike = {
    execute: (
      args: { question: string; options?: string[] },
      ctx: unknown,
    ) => Promise<unknown>;
  };

  /** Capture the clarificationId emitted in the IPC payload — that's
   *  the key the renderer feeds back to drainClarificationResolver. */
  const setupTool = (taskId: string) => {
    const sendSpy = vi.fn();
    const sender = {
      isDestroyed: () => false,
      send: sendSpy,
    } as unknown as WebContents;
    const registry = buildAgentToolRegistry({ sender, taskId });
    const tool = registry.get("askClarification") as ToolLike | undefined;
    return { tool, sendSpy };
  };

  it("returns an unresolved Promise until drainClarificationResolver is called", async () => {
    const { tool, sendSpy } = setupTool("task-clarify-1");
    expect(tool).toBeDefined();

    const callPromise = tool!.execute(
      { question: "Which?", options: ["A", "B"] },
      {} as unknown,
    );

    // Race against a settled-promise sentinel — if execute() resolved
    // synchronously this would lose the race.
    const sentinel = Symbol("pending");
    const race = await Promise.race([callPromise, Promise.resolve(sentinel)]);
    expect(race).toBe(sentinel);

    // Pull the clarificationId out of the emitted IPC payload — each
    // call generates its own UUID.
    expect(sendSpy).toHaveBeenCalledTimes(1);
    const payload = sendSpy.mock.calls[0]?.[1] as {
      clarificationId: string;
    };
    expect(payload.clarificationId).toBeTypeOf("string");
    expect(pendingClarifications.has(payload.clarificationId)).toBe(true);

    // Now drain — the tool's Promise should resolve with the user's
    // answer wrapped as { answer: "..." } so the model sees the choice.
    drainClarificationResolver(payload.clarificationId, "A");
    await expect(callPromise).resolves.toEqual({ answer: "A" });
    expect(pendingClarifications.has(payload.clarificationId)).toBe(false);
  });

  it("rejects when drained with null (task stopped / cancelled)", async () => {
    const { tool, sendSpy } = setupTool("task-clarify-2");
    const callPromise = tool!.execute(
      { question: "Pick", options: [] },
      {} as unknown,
    );
    const payload = sendSpy.mock.calls[0]?.[1] as { clarificationId: string };
    drainClarificationResolver(payload.clarificationId, null);
    await expect(callPromise).rejects.toThrow(/cancelled/i);
  });

  it("emits ai:stream-clarification with id (taskId), clarificationId, question + filtered options", async () => {
    const tid = "task-clarify-3";
    const { tool, sendSpy } = setupTool(tid);
    const callPromise = tool!.execute(
      { question: "Lang?", options: ["Python", "", "Go"] },
      {} as unknown,
    );
    await Promise.resolve();
    expect(sendSpy).toHaveBeenCalledTimes(1);
    const [channel, payload] = sendSpy.mock.calls[0] ?? [];
    expect(channel).toBe("ai:stream-clarification");
    const p = payload as {
      id: string;
      clarificationId: string;
      question: string;
      options: string[];
    };
    expect(p.id).toBe(tid);
    expect(typeof p.clarificationId).toBe("string");
    expect(p.question).toBe("Lang?");
    expect(p.options).toEqual(["Python", "Go"]); // empty string filtered out
    drainClarificationResolver(p.clarificationId, "Python");
    await callPromise;
  });

  it("concurrent calls on the same taskId each get an independent resolver — no overwrite", async () => {
    // Regression for the pre-fix bug where Map.set keyed by taskId let
    // the second call clobber the first resolver, hanging the first
    // Promise forever.
    const tid = "task-clarify-4";
    const { tool, sendSpy } = setupTool(tid);
    const p1 = tool!.execute({ question: "Q1" }, {} as unknown);
    const p2 = tool!.execute({ question: "Q2" }, {} as unknown);

    expect(sendSpy).toHaveBeenCalledTimes(2);
    const cid1 = (sendSpy.mock.calls[0]?.[1] as { clarificationId: string })
      .clarificationId;
    const cid2 = (sendSpy.mock.calls[1]?.[1] as { clarificationId: string })
      .clarificationId;
    expect(cid1).not.toBe(cid2);
    expect(pendingClarifications.size).toBe(2);

    drainClarificationResolver(cid1, "A1");
    drainClarificationResolver(cid2, "A2");
    await expect(p1).resolves.toEqual({ answer: "A1" });
    await expect(p2).resolves.toEqual({ answer: "A2" });
  });

  it("drainClarificationsForTask sweeps every clarification belonging to a task", async () => {
    const tid = "task-clarify-5";
    const { tool, sendSpy } = setupTool(tid);
    const p1 = tool!.execute({ question: "Q1" }, {} as unknown);
    const p2 = tool!.execute({ question: "Q2" }, {} as unknown);
    expect(pendingClarifications.size).toBe(2);
    drainClarificationsForTask(tid);
    expect(pendingClarifications.size).toBe(0);
    await expect(p1).rejects.toThrow(/cancelled/i);
    await expect(p2).rejects.toThrow(/cancelled/i);
    // Sender stub is unused after the sweep but referenced for ESLint
    // satisfaction.
    expect(sendSpy).toHaveBeenCalledTimes(2);
  });

  it("drainClarificationsForTask leaves OTHER tasks' clarifications alone", async () => {
    const { tool: tA, sendSpy: sA } = setupTool("task-A");
    const { tool: tB, sendSpy: sB } = setupTool("task-B");
    const pA = tA!.execute({ question: "QA" }, {} as unknown);
    const pB = tB!.execute({ question: "QB" }, {} as unknown);
    expect(pendingClarifications.size).toBe(2);
    drainClarificationsForTask("task-A");
    expect(pendingClarifications.size).toBe(1);
    await expect(pA).rejects.toThrow(/cancelled/i);
    // task-B's resolver still pending — feed an answer.
    const cidB = (sB.mock.calls[0]?.[1] as { clarificationId: string })
      .clarificationId;
    drainClarificationResolver(cidB, "answer-B");
    await expect(pB).resolves.toEqual({ answer: "answer-B" });
    expect(sA).toHaveBeenCalledTimes(1);
  });
});
