import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskSummary } from "../../db";

type IpcHandler = (...args: unknown[]) => unknown;
type RecordedStreamEventFixture = {
  channel: string;
  index: number;
  payload: unknown;
};

const ipcHandlers = vi.hoisted(() => new Map<string, IpcHandler>());

const dbMock = vi.hoisted(() => ({
  addTask: vi.fn(),
  deleteSkillTrust: vi.fn(),
  finishAutomationRun: vi.fn(),
  getLlmConfig: vi.fn(),
  getLlmConfigs: vi.fn(),
  getSetting: vi.fn(),
  getTaskSummary: vi.fn<() => TaskSummary | null>(() => null),
  listContextMemoryChunks: vi.fn(() => []),
  listSkillTrust: vi.fn(() => []),
  setSetting: vi.fn(),
  startAutomationRun: vi.fn(),
  updateTask: vi.fn(),
  upsertSkillTrust: vi.fn(),
}));

const mediaRuntimeMock = vi.hoisted(() => ({
  createVideoJobForConfig: vi.fn(),
  generateImageForConfig: vi.fn(),
}));

const taskControlMock = vi.hoisted(() => ({
  abortControllers: new Map<string, AbortController>(),
  awaitPlanGate: vi.fn(() => null),
  cleanupTask: vi.fn(),
  drainClarificationResolver: vi.fn(),
  getActiveTaskForSession: vi.fn(),
  getActiveTasks: vi.fn(() => []),
  getActiveTaskTarget: vi.fn(() => null),
  getTaskEvents: vi.fn(
    (
      _taskId?: string,
      _startIndex?: number,
    ): RecordedStreamEventFixture[] => [],
  ),
  enqueueTaskSteering: vi.fn(),
  manualStopFlags: new Map<string, boolean>(),
  pendingApprovals: new Map<string, (approved: boolean) => void>(),
  pendingClarifications: new Map<string, unknown>(),
  recordTaskEvent: vi.fn(),
  redirectActiveTask: vi.fn(),
  registerActiveTask: vi.fn(),
  setTaskWorkspace: vi.fn(),
  stopTaskExecution: vi.fn(),
  toolCallToTaskMap: new Map<string, string>(),
}));

const agentLoopRunMock = vi.hoisted(() => vi.fn());
const agentLoopConfigs = vi.hoisted(() => [] as unknown[]);
const compressContextMock = vi.hoisted(() => vi.fn());

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      ipcHandlers.set(channel, handler);
    }),
  },
}));

vi.mock("../../db", () => dbMock);

vi.mock("../../ai/adapters", () => ({
  createModelWithAdapter: vi.fn(() => ({
    adapter: { buildProviderOptions: vi.fn(() => ({})) },
    model: "model",
  })),
  getAdapter: vi.fn(),
  resolveAdapterName: vi.fn((provider: string) => provider),
}));

vi.mock("../../ai/adapters/devtools", () => ({
  runWithDevtoolsTaskScope: (fn: () => unknown) => fn(),
}));

vi.mock("../../ai/error-classifier", () => ({
  classifyError: (error: unknown) => ({
    backoffMs: 0,
    maxRetries: 0,
    recoveryActions: [],
    retryable: false,
    type: "unknown",
    userMessage: error instanceof Error ? error.message : String(error),
  }),
}));

vi.mock("../../ai/context-compressor", () => ({
  compressContext: compressContextMock,
  createContextSummaryMessage: (summary?: string | null) =>
    summary
      ? { role: "system", content: `[context summary]\n${summary}` }
      : null,
  isContextSummaryMessage: (message: { role?: string; content?: unknown }) =>
    message.role === "system" &&
    typeof message.content === "string" &&
    message.content.startsWith("[context summary]"),
}));

vi.mock("../../ai/memory-debug-store", () => ({
  emitMemoryEvent: vi.fn(),
}));

vi.mock("../../ai/provider-token-count", () => ({
  countOpenAIResponsesInputTokens: vi.fn(() => Promise.resolve(null)),
  estimateToolDefinitionTokens: vi.fn(() => Promise.resolve(0)),
  supportsOpenAIResponsesInputTokenCount: vi.fn(() => true),
}));

vi.mock("../../ai/task-trace-store", () => ({
  emitTaskTraceEvent: vi.fn(),
}));

vi.mock("../../core/agent/agent-loop", () => ({
  AgentLoop: vi.fn(
    class {
      constructor(config: unknown) {
        agentLoopConfigs.push(config);
      }

      run = agentLoopRunMock;
    },
  ),
}));

vi.mock("../../core/workspace/workspace-memory", () => ({
  readWorkspaceMemory: vi.fn(() => Promise.resolve(null)),
}));

vi.mock("../../core/workspace/workspace-factory", () => ({
  createWorkspace: vi.fn(),
  isGitBackedWorkspace: vi.fn(() => false),
}));

vi.mock("../../skills", () => ({
  getAllSuggestions: vi.fn(() => []),
  skillRegistry: {
    getById: vi.fn(),
    getDiscovered: vi.fn(),
    getEnabledSkillIds: vi.fn(() => []),
    listAll: vi.fn(() => []),
    listAllDiscovered: vi.fn(() => []),
    listUserVisible: vi.fn(() => []),
    matchByCommand: vi.fn(),
    matchByPrompt: vi.fn(),
    refreshPersonalSkills: vi.fn(),
    refreshProjectSkills: vi.fn(),
    setSkillEnabled: vi.fn(),
  },
  skills: [],
}));

vi.mock("../../skills-runtime", () => ({
  executeSkill: vi.fn(),
  forgetTrust: vi.fn(),
  getTrustLevel: vi.fn(() => "high"),
  hydrateTrust: vi.fn(),
  initSkillDiscovery: vi.fn(() => Promise.resolve(0)),
  installMarketSkill: vi.fn(),
  listMarket: vi.fn(() => Promise.resolve([])),
  preprocessSkill: vi.fn(() => Promise.resolve({ systemPrompt: "" })),
  recordTrust: vi.fn(),
  uninstallMarketSkill: vi.fn(),
  wrapWithSecurityBoundary: vi.fn((prompt: string) => prompt),
}));

vi.mock("../agent-tools", () => ({
  buildAgentToolRegistry: vi.fn(() => ({
    toAiSdkTools: vi.fn(() => ({})),
  })),
  shouldEnableMemoryToolsForPrompt: vi.fn(() => false),
}));

vi.mock("../ai-models", () => ({
  getModelAndAdapterByConfigId: vi.fn(() => ({
    adapter: { extractCacheMetrics: vi.fn(() => ({})) },
    generationOptions: {},
    model: "chat-model",
    modelLimits: { contextWindow: null, maxOutputTokens: null },
    providerNativeCompaction: {
      enabled: false,
      provider: "openai",
      reason: "unsupported-api",
    },
    providerOptions: {},
  })),
  isAvailableLlmConfig: vi.fn(() => true),
  selectAvailableChatLlmConfig: vi.fn(() => ({
    config: {
      apiKey: "sk-test",
      apiPath: null,
      baseUrl: "https://api.openai.com",
      createdAt: "2026-06-23T09:00:00.000Z",
      enabled: true,
      id: "chat-cfg",
      isDefault: false,
      lastCheckedAt: "2026-06-23T09:00:00.000Z",
      lastCheckMessage: "ok",
      lastCheckStatus: "success",
      maxOutputTokens: null,
      modality: "chat",
      model: "chat-model",
      modelAvailable: true,
      modelCapabilities: null,
      modelCatalogFetchedAt: null,
      name: "chat config",
      provider: "openai",
      reasoningEffort: null,
      temperature: null,
      topP: null,
      updatedAt: "2026-06-23T09:00:00.000Z",
    },
    fallbackFromConfigId: null,
  })),
}));

vi.mock("../ai-plan-handlers", () => ({
  registerPlanHandlers: vi.fn(),
}));

vi.mock("../ai-task-control", () => taskControlMock);

vi.mock("../approval-batcher", () => ({
  settleBatch: vi.fn(),
}));

vi.mock("../approval-hook", () => ({
  buildApprovalHook: vi.fn(),
}));

vi.mock("../fork-skill-runner", () => ({
  createForkSkillRunner: vi.fn(),
}));

vi.mock("../memory-debug-handlers", () => ({
  registerMemoryDebugHandlers: vi.fn(),
}));

vi.mock("../media-runtime", () => mediaRuntimeMock);

vi.mock("../system-prompt", () => ({
  buildAgentSystemPrompt: vi.fn(() => "system"),
}));

vi.mock("../usage-handlers", () => ({
  registerUsageHandlers: vi.fn(),
}));

vi.mock("../workspace-memory-handlers", () => ({
  registerWorkspaceMemoryHandlers: vi.fn(),
}));

function makeMediaConfig(
  modality: "chat" | "image" | "video",
  overrides: Record<string, unknown> = {},
) {
  return {
    apiKey: "sk-test",
    apiPath: null,
    baseUrl: "https://api.minimax.io",
    createdAt: "2026-06-23T09:00:00.000Z",
    enabled: true,
    id: `${modality}-cfg`,
    isDefault: false,
    lastCheckedAt: "2026-06-23T09:00:00.000Z",
    lastCheckMessage: "ok",
    lastCheckStatus: "success",
    maxOutputTokens: null,
    modality,
    model: `${modality}-model`,
    modelAvailable: true,
    modelCapabilities: null,
    modelCatalogFetchedAt: null,
    name: `${modality} config`,
    provider: "minimax",
    reasoningEffort: null,
    temperature: null,
    topP: null,
    updatedAt: "2026-06-23T09:00:00.000Z",
    ...overrides,
  };
}

describe("ai:executeTask media modality routing", () => {
  beforeEach(() => {
    ipcHandlers.clear();
    agentLoopConfigs.length = 0;
    vi.clearAllMocks();
    agentLoopRunMock.mockImplementation(() => {
      throw new Error("AgentLoop run was not configured for this test");
    });
    taskControlMock.abortControllers.clear();
    dbMock.listSkillTrust.mockReturnValue([]);
    let eventIndex = 0;
    taskControlMock.recordTaskEvent.mockImplementation(
      (_taskId: string, channel: string, payload: unknown) => ({
        channel,
        index: eventIndex++,
        payload,
      }),
    );
    taskControlMock.enqueueTaskSteering.mockImplementation(
      (_taskId: string, message: string) => message.trim().length > 0,
    );
  });

  const runGpt55ChatTaskWithProviderCount = async (
    inputTokens: number,
    payloadOverrides: Record<string, unknown> = {},
    agentEvents?: Array<Record<string, unknown>>,
    providerNativeCompactionEnabled = false,
  ) => {
    const aiModels = await import("../ai-models");
    const providerTokenCount = await import("../../ai/provider-token-count");
    const gpt55Config = makeMediaConfig("chat", {
      baseUrl: null,
      id: "chat-cfg",
      model: "gpt-5.5",
      modelCapabilities: {
        preferredApi: "responses",
        supportsReasoning: true,
        supportsTools: true,
        supportsVision: true,
      },
      provider: "openai",
    });
    dbMock.getLlmConfig.mockReturnValue(gpt55Config);
    dbMock.getLlmConfigs.mockReturnValue([gpt55Config]);
    vi.mocked(aiModels.selectAvailableChatLlmConfig).mockReturnValue({
      config: gpt55Config,
      fallbackFromConfigId: null,
    } as ReturnType<typeof aiModels.selectAvailableChatLlmConfig>);
    vi.mocked(aiModels.getModelAndAdapterByConfigId).mockReturnValue({
      adapter: {
        buildProviderOptions: vi.fn(() => ({})),
        createModel: vi.fn(() => "chat-model" as never),
        extractCacheMetrics: vi.fn(() => ({
          cacheReadTokens: null,
          cacheWriteTokens: null,
        })),
        name: "openai",
      },
      generationOptions: {},
      model: "chat-model",
      modelLimits: { contextWindow: 1_050_000, maxOutputTokens: null },
      modelId: "gpt-5.5",
      configId: "chat-cfg",
      providerNativeCompaction: {
        ...(providerNativeCompactionEnabled
          ? {
              enabled: true as const,
              mode: "openai-context-management-compact" as const,
              provider: "openai" as const,
              triggerTokens: 735_000,
            }
          : {
              enabled: false as const,
              provider: "openai" as const,
              reason: "unsupported-api" as const,
            }),
      },
      providerOptions: {},
    });
    vi.mocked(
      providerTokenCount.countOpenAIResponsesInputTokens,
    ).mockResolvedValue({
      accuracy: "actual",
      inputTokens,
      provider: "openai",
      source: "openai-responses-input-tokens",
    });
    agentLoopRunMock.mockImplementation(async function* () {
      for (const event of agentEvents ?? []) yield event;
      yield {
        type: "agent_end" as const,
        agentId: "parent-task",
        status: "completed",
        finalText: "Done",
        totalUsage: { inputTokens, outputTokens: 20 },
      };
    });

    const { registerAIHandlers } = await import("../ai-handlers");
    registerAIHandlers();
    const handler = ipcHandlers.get("ai:executeTask");
    const sender = {
      isDestroyed: vi.fn(() => false),
      send: vi.fn(),
    };

    await handler?.(
      { sender },
      {
        assistantMessageId: "assistant-chat",
        llmConfigId: "chat-cfg",
        prompt: "Continue",
        sessionId: "session-chat",
        workspacePath: process.cwd(),
        ...payloadOverrides,
      },
    );

    return Object.assign(agentLoopConfigs.at(-1) as object, {
      sender,
    }) as {
      history?: Array<{ role: string; content: unknown }>;
      hooks?: {
        transformStepContext?: (
          messages: Array<{ role: "user"; content: string }>,
          signal: AbortSignal,
        ) => Promise<unknown>;
      };
      sender: typeof sender;
    };
  };

  it("stores parent plus subagent token usage for chat tasks", async () => {
    agentLoopRunMock.mockImplementation(async function* () {
      yield {
        type: "tool_execution_end" as const,
        agentId: "parent-task",
        toolCallId: "tool-spawn",
        toolName: "spawnSubagent",
        result: {
          success: true,
          reports: [
            {
              usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
            },
            {
              usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 },
            },
          ],
        },
        success: true,
        durationMs: 0,
      };
      yield {
        type: "agent_end" as const,
        agentId: "parent-task",
        status: "completed",
        finalText: "Done",
        totalUsage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
        contextUsage: {
          latestStepContextTokens: 50,
          maxStepContextTokens: 70,
        },
      };
    });

    const { registerAIHandlers } = await import("../ai-handlers");
    registerAIHandlers();
    const handler = ipcHandlers.get("ai:executeTask");
    expect(handler).toBeTypeOf("function");

    const sender = {
      isDestroyed: vi.fn(() => false),
      send: vi.fn(),
    };

    const result = await handler?.(
      { sender },
      {
        assistantMessageId: "assistant-chat",
        llmConfigId: "chat-cfg",
        prompt: "Research with subagents",
        sessionId: "session-chat",
        workspacePath: process.cwd(),
      },
    );

    expect(result).toMatchObject({ status: "completed" });
    expect(dbMock.updateTask).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({
        inputTokens: 130,
        outputTokens: 30,
        totalTokens: 160,
      }),
    );
    expect(sender.send).toHaveBeenCalledWith(
      "ai:stream-done",
      expect.objectContaining({
        contextUsage: {
          latestStepContextTokens: 50,
          maxStepContextTokens: 70,
        },
      }),
    );
  });

  it("routes image configs through media runtime and streams an image part", async () => {
    const config = makeMediaConfig("image");
    dbMock.getLlmConfig.mockReturnValue(config);
    dbMock.getLlmConfigs.mockReturnValue([config]);
    mediaRuntimeMock.generateImageForConfig.mockResolvedValue({
      configId: "image-cfg",
      imageId: "image-1",
      modelId: "image-model",
      path: "/tmp/generated/image.png",
      prompt: "生成一张图",
    });

    const { registerAIHandlers } = await import("../ai-handlers");
    registerAIHandlers();
    const handler = ipcHandlers.get("ai:executeTask");
    expect(handler).toBeTypeOf("function");

    const sent: Array<[string, unknown]> = [];
    const sender = {
      isDestroyed: vi.fn(() => false),
      send: vi.fn((channel: string, payload: unknown) => {
        sent.push([channel, payload]);
      }),
    };

    const result = await handler?.(
      { sender },
      {
        assistantMessageId: "assistant-1",
        llmConfigId: "image-cfg",
        prompt: "生成一张图",
        sessionId: "session-1",
        workspacePath: "/tmp/workspace",
      },
    );

    expect(result).toMatchObject({ status: "completed" });
    expect(dbMock.addTask).toHaveBeenCalledWith(
      expect.objectContaining({
        assistantMessageId: "assistant-1",
        sessionId: "session-1",
        status: "running",
        updatedAt: expect.any(String),
      }),
    );
    const streamStart = sent.find(([channel]) => channel === "ai:stream-start");
    const taskId =
      streamStart &&
      typeof streamStart[1] === "object" &&
      streamStart[1] !== null &&
      "id" in streamStart[1]
        ? String(streamStart[1].id)
        : null;
    expect(sent).toContainEqual([
      "ai:stream-event",
      {
        channel: "ai:stream-media",
        id: taskId,
        index: 1,
      },
    ]);
    expect(mediaRuntimeMock.generateImageForConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        llmConfigId: "image-cfg",
        prompt: "生成一张图",
        sessionId: "session-1",
        signal: expect.any(AbortSignal),
      }),
    );
    expect(sent).toContainEqual([
      "ai:stream-media",
      expect.objectContaining({
        assistantMessageId: "assistant-1",
        part: expect.objectContaining({
          imageId: "image-1",
          path: "/tmp/generated/image.png",
          type: "image",
        }),
        sessionId: "session-1",
      }),
    ]);
    expect(sent.map(([channel]) => channel)).toContain("ai:stream-done");
    expect(sent.map(([channel]) => channel)).not.toContain("ai:stream-error");
  });

  it("emits stream event metadata before replayed events on reattach", async () => {
    taskControlMock.getTaskEvents.mockReturnValue([
      {
        channel: "ai:stream-delta",
        index: 3,
        payload: { delta: "replayed", id: "task-replay" },
      },
    ]);
    taskControlMock.redirectActiveTask.mockReturnValue(true);

    const { registerAIHandlers } = await import("../ai-handlers");
    registerAIHandlers();
    const handler = ipcHandlers.get("ai:reattachTask");
    expect(handler).toBeTypeOf("function");

    const sent: Array<[string, unknown]> = [];
    const sender = {
      isDestroyed: vi.fn(() => false),
      send: vi.fn((channel: string, payload: unknown) => {
        sent.push([channel, payload]);
      }),
    };

    const result = await handler?.({ sender }, "task-replay", 3);

    expect(result).toBe(true);
    expect(taskControlMock.getTaskEvents).toHaveBeenCalledWith(
      "task-replay",
      3,
    );
    expect(sent).toEqual([
      [
        "ai:stream-event",
        {
          channel: "ai:stream-delta",
          id: "task-replay",
          index: 3,
        },
      ],
      ["ai:stream-delta", { delta: "replayed", id: "task-replay" }],
    ]);
  });

  it("queues runtime steering messages through ai:steerTask", async () => {
    taskControlMock.enqueueTaskSteering.mockReturnValue(true);

    const { registerAIHandlers } = await import("../ai-handlers");
    registerAIHandlers();
    const handler = ipcHandlers.get("ai:steerTask");
    expect(handler).toBeTypeOf("function");

    const result = await handler?.(
      {},
      { taskId: "task-steer", message: "  focus on the failing test  " },
    );

    expect(result).toEqual({ ok: true, accepted: true });
    expect(taskControlMock.enqueueTaskSteering).toHaveBeenCalledWith(
      "task-steer",
      "  focus on the failing test  ",
    );
  });

  it("rejects empty runtime steering messages", async () => {
    const { registerAIHandlers } = await import("../ai-handlers");
    registerAIHandlers();
    const handler = ipcHandlers.get("ai:steerTask");

    const result = await handler?.({}, { taskId: "task-steer", message: "  " });

    expect(result).toEqual({ ok: false, accepted: false });
    expect(taskControlMock.enqueueTaskSteering).not.toHaveBeenCalled();
  });

  it("routes saved custom gpt-image configs through media runtime even if the stored modality is chat", async () => {
    const config = makeMediaConfig("chat", {
      apiPath: "/v1/chat/completions",
      baseUrl: "https://gateway.example.com",
      id: "custom-gpt-image-cfg",
      model: "gpt-image-2",
      name: "custom gpt-image",
      provider: "custom",
    });
    dbMock.getLlmConfig.mockReturnValue(config);
    dbMock.getLlmConfigs.mockReturnValue([config]);
    mediaRuntimeMock.generateImageForConfig.mockResolvedValue({
      configId: "custom-gpt-image-cfg",
      imageId: "image-2",
      modelId: "gpt-image-2",
      path: "/tmp/generated/gpt-image.png",
      prompt: "生成一张图",
    });

    const { registerAIHandlers } = await import("../ai-handlers");
    registerAIHandlers();
    const handler = ipcHandlers.get("ai:executeTask");
    expect(handler).toBeTypeOf("function");

    const sent: Array<[string, unknown]> = [];
    const sender = {
      isDestroyed: vi.fn(() => false),
      send: vi.fn((channel: string, payload: unknown) => {
        sent.push([channel, payload]);
      }),
    };

    const result = await handler?.(
      { sender },
      {
        assistantMessageId: "assistant-3",
        llmConfigId: "custom-gpt-image-cfg",
        prompt: "生成一张图",
        sessionId: "session-3",
        workspacePath: "/tmp/workspace",
      },
    );

    expect(result).toMatchObject({ status: "completed" });
    expect(mediaRuntimeMock.generateImageForConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        llmConfigId: "custom-gpt-image-cfg",
        prompt: "生成一张图",
        sessionId: "session-3",
        signal: expect.any(AbortSignal),
      }),
    );
    expect(sent).toContainEqual([
      "ai:stream-media",
      expect.objectContaining({
        assistantMessageId: "assistant-3",
        part: expect.objectContaining({
          imageId: "image-2",
          path: "/tmp/generated/gpt-image.png",
          type: "image",
        }),
        sessionId: "session-3",
      }),
    ]);
  });

  it("routes video configs through media runtime and streams a video-job part", async () => {
    const config = makeMediaConfig("video");
    dbMock.getLlmConfig.mockReturnValue(config);
    dbMock.getLlmConfigs.mockReturnValue([config]);
    mediaRuntimeMock.createVideoJobForConfig.mockResolvedValue({
      configId: "video-cfg",
      jobId: "job-1",
      modelId: "video-model",
      prompt: "生成视频",
      status: "queued",
    });

    const { registerAIHandlers } = await import("../ai-handlers");
    registerAIHandlers();
    const handler = ipcHandlers.get("ai:executeTask");
    expect(handler).toBeTypeOf("function");

    const sent: Array<[string, unknown]> = [];
    const sender = {
      isDestroyed: vi.fn(() => false),
      send: vi.fn((channel: string, payload: unknown) => {
        sent.push([channel, payload]);
      }),
    };

    const result = await handler?.(
      { sender },
      {
        assistantMessageId: "assistant-2",
        llmConfigId: "video-cfg",
        prompt: "生成视频",
        sessionId: "session-2",
        workspacePath: "/tmp/workspace",
      },
    );

    expect(result).toMatchObject({ status: "completed" });
    expect(mediaRuntimeMock.createVideoJobForConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        llmConfigId: "video-cfg",
        prompt: "生成视频",
        sessionId: "session-2",
        signal: expect.any(AbortSignal),
      }),
      expect.objectContaining({
        send: expect.any(Function),
      }),
    );
    expect(sent).toContainEqual([
      "ai:stream-media",
      expect.objectContaining({
        assistantMessageId: "assistant-2",
        part: expect.objectContaining({
          jobId: "job-1",
          status: "queued",
          type: "video-job",
        }),
        sessionId: "session-2",
      }),
    ]);
    expect(sent.map(([channel]) => channel)).toContain("ai:stream-done");
    expect(sent.map(([channel]) => channel)).not.toContain("ai:stream-error");
  });

  it("does not start GPT-5.5 context compression below the API trigger budget", async () => {
    const loopConfig = await runGpt55ChatTaskWithProviderCount(500_000);
    const messages = [{ role: "user" as const, content: "hello" }];
    const transformed = await loopConfig.hooks?.transformStepContext?.(
      messages,
      new AbortController().signal,
    );

    expect(transformed).toEqual({ messages });
    expect(compressContextMock).not.toHaveBeenCalled();
  });

  it("forwards persisted OpenAI compaction state to the chat stream", async () => {
    const result = await runGpt55ChatTaskWithProviderCount(500_000, {}, [
      {
        type: "provider_context",
        agentId: "parent-task",
        part: {
          type: "provider-context",
          provider: "openai",
          kind: "compaction",
          itemId: "cmp_123",
          encryptedContent: "encrypted-state",
        },
      },
    ]);

    expect(result.sender.send).toHaveBeenCalledWith(
      "ai:stream-provider-context",
      expect.objectContaining({
        assistantMessageId: "assistant-chat",
        sessionId: "session-chat",
        part: expect.objectContaining({
          type: "provider-context",
          itemId: "cmp_123",
        }),
      }),
    );
  });

  it("uses one exact provider count and estimates low-risk follow-up steps", async () => {
    const providerTokenCount = await import("../../ai/provider-token-count");
    const loopConfig = await runGpt55ChatTaskWithProviderCount(500_000);
    const transform = loopConfig.hooks?.transformStepContext;
    const signal = new AbortController().signal;

    await transform?.([{ role: "user", content: "step one" }], signal);
    await transform?.([{ role: "user", content: "step two" }], signal);

    expect(
      providerTokenCount.countOpenAIResponsesInputTokens,
    ).toHaveBeenCalledTimes(1);
    expect(
      providerTokenCount.countOpenAIResponsesInputTokens,
    ).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gpt-5.5", provider: "openai" }),
      [{ role: "user", content: "step one" }],
      expect.objectContaining({
        instructions: "system",
        signal,
        tools: {},
      }),
    );
  });

  it("refreshes the exact provider count when the estimate approaches the trigger", async () => {
    const providerTokenCount = await import("../../ai/provider-token-count");
    const loopConfig = await runGpt55ChatTaskWithProviderCount(500_000);
    const transform = loopConfig.hooks?.transformStepContext;
    const signal = new AbortController().signal;

    vi.mocked(
      providerTokenCount.countOpenAIResponsesInputTokens,
    ).mockResolvedValueOnce({
      accuracy: "actual",
      inputTokens: 500_000,
      provider: "openai",
      source: "openai-responses-input-tokens",
    });
    vi.mocked(
      providerTokenCount.countOpenAIResponsesInputTokens,
    ).mockResolvedValueOnce({
      accuracy: "actual",
      inputTokens: 700_000,
      provider: "openai",
      source: "openai-responses-input-tokens",
    });

    await transform?.([{ role: "user", content: "small" }], signal);
    await transform?.(
      [{ role: "user", content: "x".repeat(1_100_000) }],
      signal,
    );

    expect(
      providerTokenCount.countOpenAIResponsesInputTokens,
    ).toHaveBeenCalledTimes(2);
  });

  it("skips separate token preflight when provider-native compaction is enabled", async () => {
    const providerTokenCount = await import("../../ai/provider-token-count");
    const loopConfig = await runGpt55ChatTaskWithProviderCount(
      500_000,
      {},
      undefined,
      true,
    );
    const transform = loopConfig.hooks?.transformStepContext;

    await transform?.(
      [{ role: "user", content: "step one" }],
      new AbortController().signal,
    );
    await transform?.(
      [{ role: "user", content: "step two" }],
      new AbortController().signal,
    );

    expect(
      providerTokenCount.countOpenAIResponsesInputTokens,
    ).not.toHaveBeenCalled();
  });

  it("does not treat cumulative history usage as current request occupancy", async () => {
    await runGpt55ChatTaskWithProviderCount(500_000, {
      contextInputTokens: 900_000,
      history: [
        { id: "user-1", role: "user", content: "Earlier request" },
        {
          id: "assistant-1",
          role: "assistant",
          content: "Earlier answer",
          parts: [
            {
              type: "usage",
              inputTokens: 900_000,
              outputTokens: 20_000,
              totalTokens: 920_000,
            },
          ],
        },
      ],
    });

    expect(compressContextMock).not.toHaveBeenCalled();
  });

  it("applies a valid rolling-summary watermark before converting history", async () => {
    dbMock.getTaskSummary.mockReturnValue({
      taskId: "session:session-chat",
      createdAt: "2026-07-13T12:00:00.000Z",
      summary: "## 已完成\n- covered work",
      coveredThroughMessageId: "m4",
      retainedTailStartId: "m5",
      summaryVersion: 1,
      sourceTokenCount: 200_000,
      lastCompactedAt: "2026-07-13T12:00:00.000Z",
    });
    const loopConfig = await runGpt55ChatTaskWithProviderCount(500_000, {
      history: [
        { id: "m1", role: "user", content: "pinned user" },
        { id: "m2", role: "assistant", content: "pinned assistant" },
        { id: "m3", role: "user", content: "covered old request" },
        { id: "m4", role: "assistant", content: "covered old answer" },
        { id: "m5", role: "user", content: "new request" },
      ],
    });
    const renderedHistory = JSON.stringify(loopConfig.history);

    expect(renderedHistory).toContain("covered work");
    expect(renderedHistory).toContain("pinned user");
    expect(renderedHistory).toContain("new request");
    expect(renderedHistory).not.toContain("covered old request");
    expect(renderedHistory).not.toContain("covered old answer");
  });

  it("starts GPT-5.5 context compression after provider input exceeds the API trigger budget", async () => {
    compressContextMock.mockResolvedValue({
      compressedTokens: 100,
      hadError: false,
      messages: [{ role: "user", content: "compressed" }],
      originalTokens: 900_000,
      summaryTokens: 20,
      wasCompressed: true,
    });
    const loopConfig = await runGpt55ChatTaskWithProviderCount(900_000);
    const messages = [{ role: "user" as const, content: "hello" }];
    await loopConfig.hooks?.transformStepContext?.(
      messages,
      new AbortController().signal,
    );

    expect(compressContextMock).toHaveBeenCalledWith(
      messages,
      expect.objectContaining({
        force: true,
        promptSnippet: "Continue",
      }),
    );
    const [, options] = compressContextMock.mock.calls[0] ?? [];
    expect(
      (options as { budget?: number } | undefined)?.budget,
    ).toBeGreaterThan(500_000);
    expect((options as { budget?: number } | undefined)?.budget).toBeLessThan(
      525_000,
    );
  });

  it("preserves step context when soft-limit summarization fails", async () => {
    const messages = [
      { role: "user" as const, content: "old context" },
      { role: "user" as const, content: "latest request" },
    ];
    compressContextMock.mockResolvedValue({
      compressedTokens: 10,
      hadError: true,
      messages: [messages[1]],
      originalTokens: 900_000,
      summaryTokens: 0,
      wasCompressed: false,
    });
    const loopConfig = await runGpt55ChatTaskWithProviderCount(900_000);

    const transformed = await loopConfig.hooks?.transformStepContext?.(
      messages,
      new AbortController().signal,
    );

    expect(transformed).toEqual({ messages });
  });
});
