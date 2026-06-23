import { beforeEach, describe, expect, it, vi } from "vitest";

type IpcHandler = (...args: unknown[]) => unknown;

const ipcHandlers = vi.hoisted(() => new Map<string, IpcHandler>());

const dbMock = vi.hoisted(() => ({
  addTask: vi.fn(),
  deleteSkillTrust: vi.fn(),
  finishAutomationRun: vi.fn(),
  getLlmConfig: vi.fn(),
  getLlmConfigs: vi.fn(),
  getSetting: vi.fn(),
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
  getTaskEvents: vi.fn(() => []),
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

vi.mock("../../ai/memory-debug-store", () => ({
  emitMemoryEvent: vi.fn(),
}));

vi.mock("../../ai/task-trace-store", () => ({
  emitTaskTraceEvent: vi.fn(),
}));

vi.mock("../../core/agent/agent-loop", () => ({
  AgentLoop: vi.fn(() => {
    throw new Error("AgentLoop should not run for media modalities");
  }),
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
  buildAgentToolRegistry: vi.fn(),
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

function makeMediaConfig(modality: "image" | "video") {
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
  };
}

describe("ai:executeTask media modality routing", () => {
  beforeEach(() => {
    ipcHandlers.clear();
    vi.clearAllMocks();
    taskControlMock.abortControllers.clear();
    dbMock.listSkillTrust.mockReturnValue([]);
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
});
