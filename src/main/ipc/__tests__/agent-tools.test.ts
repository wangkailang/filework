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

import {
  buildAgentToolRegistry,
  resolveSubagentAllowedSkillIds,
  resolveSubagentAllowedTools,
  resolveSubagentTermination,
  shapeSubagentToolResult,
  shouldEnableMemoryToolsForPrompt,
} from "../agent-tools";
import {
  approvedInlinePlanTasks,
  drainClarificationResolver,
  drainClarificationsForTask,
  drainPlanResolver,
  pendingClarifications,
  pendingPlanApprovals,
} from "../ai-task-control";

// 双重保险:在测试之间保持模块级 Map 干净,避免某个忘记 drain 的
// 用例污染下一个用例。
afterEach(() => {
  pendingClarifications.clear();
  pendingPlanApprovals.clear();
  approvedInlinePlanTasks.clear();
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
    if (!tool) throw new Error("askClarification tool was not registered");
    return { tool, sendSpy };
  };

  it("returns an unresolved Promise until drainClarificationResolver is called", async () => {
    const { tool, sendSpy } = setupTool("task-clarify-1");

    const callPromise = tool.execute(
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
    const callPromise = tool.execute(
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
    const callPromise = tool.execute(
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
    const p1 = tool.execute({ question: "Q1" }, {} as unknown);
    const p2 = tool.execute({ question: "Q2" }, {} as unknown);

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
    const p1 = tool.execute({ question: "Q1" }, {} as unknown);
    const p2 = tool.execute({ question: "Q2" }, {} as unknown);
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
    const pA = tA.execute({ question: "QA" }, {} as unknown);
    const pB = tB.execute({ question: "QB" }, {} as unknown);
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

describe("createPlan tool — approval resumes execution", () => {
  type CreatePlanToolLike = {
    execute: (
      args: {
        goal: string;
        steps: Array<{
          action: string;
          description?: string;
          status?: "pending" | "running" | "completed" | "failed" | "skipped";
        }>;
      },
      ctx: unknown,
    ) => Promise<unknown>;
  };

  const setupCreatePlanTool = (
    taskId: string,
    options: { autoApprovePlans?: boolean } = {},
  ) => {
    const sendSpy = vi.fn();
    const sender = {
      isDestroyed: () => false,
      send: sendSpy,
    } as unknown as WebContents;
    const registry = buildAgentToolRegistry({ sender, taskId, ...options });
    const tool = registry.get("createPlan") as CreatePlanToolLike | undefined;
    return { tool, sendSpy };
  };

  it("returns an explicit continue instruction after the user approves the draft plan", async () => {
    const taskId = "task-plan-approval";
    const { tool, sendSpy } = setupCreatePlanTool(taskId);
    if (!tool) throw new Error("createPlan tool was not registered");

    const callPromise = tool.execute(
      {
        goal: "Solve the puzzle",
        steps: [
          { action: "Enumerate distributions" },
          { action: "Analyze guarantees" },
        ],
      },
      {} as unknown,
    );

    expect(sendSpy).toHaveBeenCalledWith("ai:stream-plan", {
      id: taskId,
      plan: expect.objectContaining({
        status: "draft",
        steps: [
          expect.objectContaining({ status: "pending" }),
          expect.objectContaining({ status: "pending" }),
        ],
      }),
    });

    drainPlanResolver(taskId, true);

    await expect(callPromise).resolves.toMatchObject({
      approved: true,
      continueExecution: true,
      nextInstruction: expect.stringMatching(/continue.*plan/i),
    });
  });

  it("auto-approves the draft plan when chat permissions skip approvals", async () => {
    const taskId = "task-plan-auto-approval";
    const { tool, sendSpy } = setupCreatePlanTool(taskId, {
      autoApprovePlans: true,
    });
    if (!tool) throw new Error("createPlan tool was not registered");

    await expect(
      tool.execute(
        {
          goal: "Apply the feature",
          steps: [{ action: "Add tests" }, { action: "Implement behavior" }],
        },
        {} as unknown,
      ),
    ).resolves.toMatchObject({
      approved: true,
      autoApproved: true,
      continueExecution: true,
      nextInstruction: expect.stringMatching(/continue.*plan/i),
    });

    expect(sendSpy).toHaveBeenCalledWith("ai:stream-plan", {
      id: taskId,
      plan: expect.objectContaining({
        status: "executing",
        steps: [
          expect.objectContaining({ status: "pending" }),
          expect.objectContaining({ status: "pending" }),
        ],
      }),
    });
    expect(pendingPlanApprovals.has(taskId)).toBe(false);
    expect(approvedInlinePlanTasks.has(taskId)).toBe(true);
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

  it("schema preserves supported subagent profiles and rejects unknown profiles", () => {
    const registry = buildAgentToolRegistry({
      sender,
      taskId: "main-profile",
      enableSubagent: true,
      parentSignal: new AbortController().signal,
      workspacePath: "/ws",
    });
    const tool = registry.get("spawnSubagent");
    if (!tool) throw new Error("spawnSubagent tool was not registered");

    const parsed = tool.inputSchema.safeParse({
      tasks: [
        {
          goal: "Research current options",
          prompt: "Find source-backed options and summarize tradeoffs.",
          profile: "researcher",
        },
      ],
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const parsedData = parsed.data as {
      tasks: Array<{ profile?: string }>;
    };
    expect(parsedData.tasks[0]?.profile).toBe("researcher");

    const invalid = tool.inputSchema.safeParse({
      tasks: [
        {
          goal: "Do mystery work",
          prompt: "Use an unknown specialist mode.",
          profile: "mystery_agent",
        },
      ],
    });
    expect(invalid.success).toBe(false);
  });

  it("filters direct-write tools out of subagent grants by default", () => {
    expect(
      resolveSubagentAllowedTools(undefined, [
        "readFile",
        "searchFiles",
        "writeFile",
        "deleteFile",
        "runCommand",
        "runProcess",
        "updateMemory",
      ]),
    ).toEqual(["readFile", "searchFiles", "runCommand", "runProcess"]);

    expect(
      resolveSubagentAllowedTools(
        ["readFile", "writeFile", "moveFile", "webSearch", "runCommand"],
        undefined,
      ),
    ).toEqual(["readFile", "webSearch", "runCommand"]);

    const defaultTools = resolveSubagentAllowedTools(undefined, undefined);
    expect(defaultTools).toContain("readFile");
    expect(defaultTools).toContain("listDirectory");
    expect(defaultTools).toContain("webSearch");
    expect(defaultTools).toContain("runCommand");
    expect(defaultTools).toContain("runProcess");
    expect(defaultTools).not.toContain("writeFile");
    expect(defaultTools).not.toContain("automation_update");
  });

  it("allows direct file-write tools only for explicit worktree-isolated subagents", () => {
    expect(
      resolveSubagentAllowedTools(
        undefined,
        ["readFile", "writeFile", "moveFile", "deleteFile", "updateMemory"],
        { allowDirectWrite: true },
      ),
    ).toEqual(["readFile", "writeFile", "moveFile", "deleteFile"]);

    expect(
      resolveSubagentAllowedTools(
        ["readFile", "writeFile", "runCommand"],
        ["readFile", "writeFile", "deleteFile"],
        { allowDirectWrite: true },
      ),
    ).toEqual(["readFile", "writeFile"]);
  });

  it("treats an empty requested allowedTools array as omitted so subagents still get default read-only tools", () => {
    const tools = resolveSubagentAllowedTools(undefined, []);

    expect(tools).toContain("readFile");
    expect(tools).toContain("listDirectory");
    expect(tools).toContain("runCommand");
    expect(tools).not.toContain("writeFile");
  });

  it("keeps spawnSubagent useful when the parent grant only contains the delegation tool", () => {
    const tools = resolveSubagentAllowedTools(["spawnSubagent"], undefined);

    expect(tools).toContain("readFile");
    expect(tools).toContain("listDirectory");
    expect(tools).toContain("runCommand");
    expect(tools).not.toContain("spawnSubagent");
  });

  it("does not let a delegation-only parent grant erase explicit read-only child tool requests", () => {
    const tools = resolveSubagentAllowedTools(
      ["spawnSubagent"],
      ["readFile", "runCommand", "writeFile"],
    );

    expect(tools).toEqual(["readFile", "runCommand"]);
  });

  it("normalizes provider-prefixed tool names before resolving subagent grants", () => {
    const tools = resolveSubagentAllowedTools(undefined, [
      "functions.listDirectory",
      "functions.readFile",
      "functions.searchFiles",
      "functions.runCommand",
      "functions.writeFile",
      "functions.spawnSubagent",
    ]);

    expect(tools).toEqual([
      "listDirectory",
      "readFile",
      "searchFiles",
      "runCommand",
    ]);
  });

  it("does not inject parent skills into subagents unless explicitly requested", () => {
    expect(
      resolveSubagentAllowedSkillIds(["pdf", "browser"], undefined),
    ).toEqual([]);
    expect(resolveSubagentAllowedSkillIds(["pdf", "browser"], [])).toEqual([]);
    expect(
      resolveSubagentAllowedSkillIds(["pdf", "browser"], ["browser", "write"]),
    ).toEqual(["browser"]);
  });

  it("uses larger default limits for researcher subagents while preserving explicit overrides", () => {
    expect(resolveSubagentTermination("researcher", {})).toEqual({
      maxTurns: 16,
      maxTotalTokens: 180_000,
      maxWallMs: 300_000,
    });
    expect(
      resolveSubagentTermination("code_reviewer", {
        maxTurns: undefined,
        maxTotalTokens: undefined,
        maxWallMs: undefined,
      }),
    ).toMatchObject({
      maxTurns: expect.any(Number),
      maxTotalTokens: expect.any(Number),
      maxWallMs: expect.any(Number),
    });
    expect(
      resolveSubagentTermination("researcher", {
        maxTurns: 4,
        maxTotalTokens: 10_000,
        maxWallMs: 30_000,
      }),
    ).toEqual({
      maxTurns: 4,
      maxTotalTokens: 10_000,
      maxWallMs: 30_000,
    });
  });

  it("marks only complete reports as usable for the parent agent", () => {
    const result = shapeSubagentToolResult({
      batchId: "batch-usable",
      goals: ["done", "partial", "startup"],
      reports: [
        {
          agentId: "child-1",
          status: "ok",
          resultQuality: "complete",
          summary: "Done.",
          artifacts: { status: "complete", findings: [{ claim: "A" }] },
          usage: { inputTokens: null, outputTokens: null, totalTokens: null },
          toolCallCount: 1,
          durationMs: 100,
        },
        {
          agentId: "child-2",
          status: "token_limit",
          resultQuality: "usable_partial",
          summary: "Partial.",
          artifacts: { status: "partial", findings: [{ claim: "B" }] },
          usage: { inputTokens: null, outputTokens: null, totalTokens: null },
          toolCallCount: 2,
          durationMs: 200,
        },
        {
          agentId: "child-3",
          status: "token_limit",
          resultQuality: "no_result",
          summary: "I will start.",
          usage: { inputTokens: null, outputTokens: null, totalTokens: null },
          toolCallCount: 0,
          durationMs: 300,
        },
      ],
    });

    expect(result.summary).toEqual({
      total: 3,
      usable: 1,
      complete: 1,
      partial: 1,
      noResult: 1,
      failed: 0,
      incomplete: 2,
      allComplete: false,
      requiresFollowup: true,
    });
    expect(result.incompleteGoals).toEqual(["partial", "startup"]);
    expect(result.reports.map((r) => r.usable)).toEqual([true, false, false]);
    expect(result.reports[1]).toMatchObject({
      resultQuality: "usable_partial",
      summary: "",
      artifacts: undefined,
      unusableReason: "Sub-agent stopped before producing validated findings.",
    });
    expect(result.reports[2]).toMatchObject({
      resultQuality: "no_result",
      unusableReason: "Sub-agent stopped before producing validated findings.",
    });
  });
});

describe("automation_update tool — 注册入口", () => {
  const sender = {
    isDestroyed: () => false,
    send: vi.fn(),
  } as unknown as WebContents;

  it("主工具集默认注册 automation_update", () => {
    const registry = buildAgentToolRegistry({
      sender,
      taskId: "automation-main",
      currentThreadId: "session-1",
      workspacePath: "/ws",
    });
    expect(registry.has("automation_update")).toBe(true);
  });

  it("allowedTools 不含 automation_update 时不注册", () => {
    const registry = buildAgentToolRegistry({
      sender,
      taskId: "automation-limited",
      allowedTools: ["readFile"],
      currentThreadId: "session-1",
      workspacePath: "/ws",
    });
    expect(registry.has("automation_update")).toBe(false);
  });
});

describe("memory tools — 仅在显式记忆意图下注册", () => {
  const sender = {
    isDestroyed: () => false,
    send: vi.fn(),
  } as unknown as WebContents;

  it("普通 chat 默认不注册 updateMemory / clearMemory", () => {
    const registry = buildAgentToolRegistry({
      sender,
      taskId: "memory-ordinary",
      workspacePath: "/ws",
    });

    expect(registry.has("updateMemory")).toBe(false);
    expect(registry.has("clearMemory")).toBe(false);
  });

  it("显式要求记住内容时才开启 memory 工具", () => {
    const registry = buildAgentToolRegistry({
      sender,
      taskId: "memory-explicit",
      workspacePath: "/ws",
      enableMemoryTools: shouldEnableMemoryToolsForPrompt(
        "记住我在这个项目里偏好 pnpm test",
      ),
    });

    expect(registry.has("updateMemory")).toBe(true);
    expect(registry.has("clearMemory")).toBe(true);
  });

  it("中文自然表达“帮我记住”也会开启 memory 工具", () => {
    expect(shouldEnableMemoryToolsForPrompt("帮我记住我偏好用中文回复")).toBe(
      true,
    );
  });

  it("显式 allowedTools 仍可按白名单注册 updateMemory", () => {
    const registry = buildAgentToolRegistry({
      sender,
      taskId: "memory-allowed-tools",
      allowedTools: ["updateMemory"],
      workspacePath: "/ws",
    });

    expect(registry.has("updateMemory")).toBe(true);
    expect(registry.has("clearMemory")).toBe(false);
  });

  it("普通旅行规划不被误判为记忆意图", () => {
    expect(
      shouldEnableMemoryToolsForPrompt(
        "帮我规划 3 天东京自由行：必去 5 个地方、推荐住宿区域、每天行程、预算估算",
      ),
    ).toBe(false);
  });

  it("讨论 update memory 误触发问题本身不启用 memory 工具", () => {
    expect(
      shouldEnableMemoryToolsForPrompt("不应该触发 update memory tool"),
    ).toBe(false);
  });
});
