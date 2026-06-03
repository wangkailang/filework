/**
 * `buildAgentToolRegistry` 的测试 —— 聚焦于 `askClarification` 的阻塞式
 * 挂起契约。
 *
 * skill 的 `allowed-tools` 白名单路径由其他代码路径隐式覆盖;这里固定
 * askClarification 的行为,防止回归重新引入非阻塞的 `{ asked: true }`
 * 捷径 —— 该捷径会让模型在用户选定选项之前就继续生成。
 */
import type { WebContents } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildAgentToolRegistry } from "../agent-tools";
import {
  drainClarificationResolver,
  drainClarificationsForTask,
  pendingClarifications,
} from "../ai-task-control";

// 双重保险:在测试之间保持模块级 Map 干净,避免某个忘记 drain 的
// 用例污染下一个用例。
afterEach(() => {
  pendingClarifications.clear();
});

describe("askClarification tool — blocks until user answers", () => {
  // 此修复的核心:该工具绝不能同步 resolve。若缺少 pendingClarifications
  // 挂起机制,模型会立即收到一个假的 `{ asked: true }`,并在用户选定选项
  // 之前继续生成。这些测试固定该挂起契约。

  // ai-sdk 将 execute 规范化为接受类型化的 args + context;就形状测试而言
  // 我们只关心返回的 Promise。
  type ToolLike = {
    execute: (
      args: { question: string; options?: string[] },
      ctx: unknown,
    ) => Promise<unknown>;
  };

  /** 捕获 IPC payload 中发出的 clarificationId —— 即 renderer 回传给
   *  drainClarificationResolver 的 key。 */
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

    // 与一个已 settled 的 promise 哨兵竞速 —— 若 execute() 同步 resolve,
    // 则会输掉这场竞速。
    const sentinel = Symbol("pending");
    const race = await Promise.race([callPromise, Promise.resolve(sentinel)]);
    expect(race).toBe(sentinel);

    // 从发出的 IPC payload 中取出 clarificationId —— 每次调用都会
    // 生成自己的 UUID。
    expect(sendSpy).toHaveBeenCalledTimes(1);
    const payload = sendSpy.mock.calls[0]?.[1] as {
      clarificationId: string;
    };
    expect(payload.clarificationId).toBeTypeOf("string");
    expect(pendingClarifications.has(payload.clarificationId)).toBe(true);

    // 现在 drain —— 工具的 Promise 应以包装成 { answer: "..." } 的用户
    // 答案 resolve,使模型看到该选择。
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
    expect(p.options).toEqual(["Python", "Go"]); // 空字符串已被过滤
    drainClarificationResolver(p.clarificationId, "Python");
    await callPromise;
  });

  it("concurrent calls on the same taskId each get an independent resolver — no overwrite", async () => {
    // 针对修复前 bug 的回归测试:当 Map.set 以 taskId 为 key 时,第二次
    // 调用会覆盖第一个 resolver,使第一个 Promise 永远挂起。
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
    // sweep 之后 sender stub 不再使用,但为满足 ESLint 而引用一次。
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
    // task-B 的 resolver 仍处于 pending —— 喂入一个答案。
    const cidB = (sB.mock.calls[0]?.[1] as { clarificationId: string })
      .clarificationId;
    drainClarificationResolver(cidB, "answer-B");
    await expect(pB).resolves.toEqual({ answer: "answer-B" });
    expect(sA).toHaveBeenCalledTimes(1);
  });
});

describe("spawnSubagent tool — 注册门控与递归防护", () => {
  const sender = {
    isDestroyed: () => false,
    send: vi.fn(),
  } as unknown as WebContents;

  it("主 agent 路径(enableSubagent + parentSignal + workspacePath)注册 spawnSubagent", () => {
    const registry = buildAgentToolRegistry({
      sender,
      taskId: "main-1",
      enableSubagent: true,
      parentSignal: new AbortController().signal,
      workspacePath: "/ws",
    });
    expect(registry.has("spawnSubagent")).toBe(true);
  });

  it("子 agent 路径(enableSubagent 缺省)不注册 spawnSubagent —— 防递归委派", () => {
    const registry = buildAgentToolRegistry({
      sender,
      taskId: "child-1",
      parentSignal: new AbortController().signal,
      workspacePath: "/ws",
    });
    expect(registry.has("spawnSubagent")).toBe(false);
  });

  it("enableSubagent 但缺 parentSignal/workspacePath 时不注册(避免半接线)", () => {
    const registry = buildAgentToolRegistry({
      sender,
      taskId: "main-2",
      enableSubagent: true,
    });
    expect(registry.has("spawnSubagent")).toBe(false);
  });

  it("allowedTools 不含 spawnSubagent 时即便 enableSubagent 也不注册", () => {
    const registry = buildAgentToolRegistry({
      sender,
      taskId: "main-3",
      enableSubagent: true,
      parentSignal: new AbortController().signal,
      workspacePath: "/ws",
      allowedTools: ["readFile"],
    });
    expect(registry.has("spawnSubagent")).toBe(false);
  });
});
