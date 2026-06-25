import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, ChatSession } from "../types";

vi.mock("../../../i18n/i18n-react", () => ({
  useI18nContext: () => ({
    LL: {
      automations_chatPromptInstructions: () => "执行指令:",
      automations_chatPromptRunId: ({ id }: { id: string }) =>
        `运行记录 ID: ${id}`,
      automations_chatPromptRunNow: ({ title }: { title: string }) =>
        `现在执行自动化: ${title}`,
      automations_chatPromptSchedule: ({
        kind,
        value,
      }: {
        kind: string;
        value: string;
      }) => `计划: ${kind} ${value}`,
      automations_chatPromptType: ({ value }: { value: string }) =>
        `自动化类型: ${value}`,
      automations_chatPromptWorkspacePaths: ({ value }: { value: string }) =>
        `工作区路径: ${value}`,
      chat_connectionTimeout: () => "连接超时",
      chat_planExecution: (goal: string) => `执行计划: ${goal}`,
      chat_planFailed: (error: string) => `计划失败: ${error}`,
      chat_unknownError: () => "未知错误",
      chat_userStopped: () => "用户已停止",
    },
  }),
}));

import { useChatSession } from "../useChatSession";

type ChatSessionValue = ReturnType<typeof useChatSession>;
type ActiveTaskMock = {
  taskId: string;
  sessionId?: string;
  assistantMessageId?: string;
  streamEventCount: number;
};

const noop = () => undefined;
const off = () => noop;

const createFileworkMock = () => ({
  answerClarification: vi.fn(),
  approvePlan: vi.fn(),
  approveSkill: vi.fn(),
  approveToolCall: vi.fn(),
  approveToolCallBatch: vi.fn(),
  automations: {
    attachRunChatSession: vi.fn(),
    prepareChatRun: vi.fn(),
  },
  cancelPlan: vi.fn(),
  createChatSession: vi.fn(),
  deleteChatSession: vi.fn(),
  executeTask: vi.fn(() => Promise.resolve()),
  forkChatSession: vi.fn(),
  getActiveTask: vi.fn(
    (_sessionId?: string): Promise<ActiveTaskMock | null> =>
      Promise.resolve(null),
  ),
  getActiveTasks: vi.fn(() => Promise.resolve([])),
  getChatHistory: vi.fn(() => Promise.resolve([] as ChatMessage[])),
  getChatSessions: vi.fn(() => Promise.resolve([] as ChatSession[])),
  llmConfig: {
    get: vi.fn(),
    list: vi.fn(() => Promise.resolve([] as unknown[])),
  },
  media: {
    createVideoJob: vi.fn(),
    generateImage: vi.fn(),
    onJobUpdate: vi.fn(off),
  },
  onCiDispatchResolveFailed: vi.fn(off),
  onCiRunDone: vi.fn(off),
  onCiRunTimeout: vi.fn(off),
  onPlanError: vi.fn(off),
  onPlanReady: vi.fn(off),
  onPlanStepArtifacts: vi.fn(off),
  onPlanStepDone: vi.fn(off),
  onPlanStepError: vi.fn(off),
  onPlanStepStart: vi.fn(off),
  onPlanSubStepProgress: vi.fn(off),
  onSkillActivated: vi.fn(off),
  onSkillApprovalRequest: vi.fn(off),
  onStreamClarification: vi.fn(off),
  onStreamDelta: vi.fn(off),
  onStreamDone: vi.fn(off),
  onStreamError: vi.fn(off),
  onStreamEvent: vi.fn(
    (
      _callback: (data: { id: string; channel: string; index: number }) => void,
    ) => noop,
  ),
  onStreamMedia: vi.fn(off),
  onStreamPlan: vi.fn(off),
  onStreamReasoning: vi.fn(off),
  onStreamReasoningEnd: vi.fn(off),
  onStreamRetry: vi.fn(off),
  onStreamStart: vi.fn(off),
  onStreamToolApproval: vi.fn(off),
  onStreamToolBatchApproval: vi.fn(off),
  onStreamToolBatchAutoApproved: vi.fn(off),
  onStreamToolCall: vi.fn(off),
  onStreamToolResult: vi.fn(off),
  onSubagentChildUsage: vi.fn(off),
  onSubagentDelta: vi.fn(off),
  onSubagentReport: vi.fn(off),
  onSubagentSpawn: vi.fn(off),
  onSubagentToolCall: vi.fn(off),
  onSubagentToolResult: vi.fn(off),
  onWatchdog: vi.fn(off),
  reattachTask: vi.fn(),
  rejectPlan: vi.fn(),
  saveChatHistory: vi.fn(),
  stopGeneration: vi.fn(() => Promise.resolve()),
  updateChatSession: vi.fn(),
  usage: {
    getTaskUsage: vi.fn(() => Promise.resolve(null)),
  },
});

describe("useChatSession", () => {
  let root: Root | null = null;
  let latest: ChatSessionValue | null = null;
  let filework: ReturnType<typeof createFileworkMock>;
  let animationCallbacks: FrameRequestCallback[];
  let localStorageMock: {
    getItem: ReturnType<typeof vi.fn>;
    removeItem: ReturnType<typeof vi.fn>;
    setItem: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    const { document, window } = parseHTML('<div id="root"></div>');
    localStorageMock = {
      getItem: vi.fn(() => null),
      removeItem: vi.fn(),
      setItem: vi.fn(),
    };

    filework = createFileworkMock();
    animationCallbacks = [];
    Object.assign(window, {
      cancelAnimationFrame: vi.fn(),
      filework,
      localStorage: localStorageMock,
      requestAnimationFrame: vi.fn((callback: FrameRequestCallback) => {
        animationCallbacks.push(callback);
        return animationCallbacks.length;
      }),
    });
    vi.stubGlobal("window", window);
    vi.stubGlobal("document", document);
    vi.stubGlobal("HTMLElement", window.HTMLElement);
    vi.stubGlobal("localStorage", localStorageMock);
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;

    root = createRoot(document.getElementById("root") as HTMLElement);
    latest = null;
  });

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
    }
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    root = null;
    latest = null;
  });

  const flushAnimationFrame = async () => {
    const callbacks = animationCallbacks.splice(0);
    await act(async () => {
      for (const callback of callbacks) callback(16);
      await Promise.resolve();
    });
  };

  it("marks a manually triggered automation session immediately in the local session list", async () => {
    const createdSession: ChatSession = {
      id: "session-manual",
      workspacePath: "/workspace",
      title: "新对话",
      createdAt: "2026-06-22T04:00:00.000Z",
      updatedAt: "2026-06-22T04:00:00.000Z",
    };
    filework.createChatSession.mockResolvedValue(createdSession);
    filework.automations.prepareChatRun.mockResolvedValue({
      assistantMessageId: "assistant-1",
      automationId: "auto-1",
      automationTitle: "每日 Filework commit 改动统计",
      chatSessionId: "session-manual",
      id: "run-manual",
      modelId: null,
      prompt: "统计提交",
      trigger: "manual",
      workspacePaths: ["/workspace"],
    });

    const Harness = () => {
      latest = useChatSession("/workspace");
      return null;
    };

    await act(async () => {
      root?.render(<Harness />);
    });

    await act(async () => {
      await latest?.handleTriggerAutomationRun({
        id: "auto-1",
        modelId: null,
        prompt: "统计提交",
        scheduleKind: "daily",
        scheduleValue: "09:00",
        title: "每日 Filework commit 改动统计",
        type: "project",
        workspacePaths: ["/workspace"],
      });
    });

    expect(latest?.sessions[0]).toMatchObject({
      automationRun: {
        automationId: "auto-1",
        id: "run-manual",
        title: "每日 Filework commit 改动统计",
      },
      id: "session-manual",
      title: "每日 Filework commit 改动统计",
    });
  });

  it("shows scheduled automation run details as transient chat without creating a session", async () => {
    const Harness = () => {
      latest = useChatSession("/workspace");
      return null;
    };

    await act(async () => {
      root?.render(<Harness />);
    });

    const opened = await act(async () =>
      latest?.handleOpenAutomationRun({
        assistantMessageId: null,
        automationId: "auto-1",
        automationTitle: "每日 AI 行业热点资讯推送",
        chatSessionId: null,
        id: "run-scheduled",
        modelId: null,
        output: "今日 AI 热点摘要",
        prompt: "搜索 AI 热门内容",
        trigger: "scheduled",
        workspacePaths: ["/workspace"],
      }),
    );

    expect(opened).toBe(true);
    expect(filework.createChatSession).not.toHaveBeenCalled();
    expect(filework.automations.attachRunChatSession).not.toHaveBeenCalled();
    expect(filework.updateChatSession).not.toHaveBeenCalled();
    expect(filework.saveChatHistory).not.toHaveBeenCalled();
    expect(latest?.activeSessionId).toBeNull();
    expect(latest?.sessions).toHaveLength(0);
    expect(latest?.messages).toEqual([
      expect.objectContaining({
        content: expect.stringContaining("run-scheduled"),
        role: "user",
      }),
      expect.objectContaining({
        content: "今日 AI 热点摘要",
        role: "assistant",
      }),
    ]);
    expect(latest?.transientAutomationRun).toEqual({
      automationId: "auto-1",
      id: "run-scheduled",
      title: "每日 AI 行业热点资讯推送",
    });
  });

  it("clears a persisted LLM config when it is not selectable", async () => {
    localStorageMock.getItem.mockReturnValue("config-error");
    filework.llmConfig.list.mockResolvedValue([
      {
        id: "config-error",
        enabled: true,
        lastCheckStatus: "error",
      },
    ]);

    const Harness = () => {
      latest = useChatSession("/workspace");
      return null;
    };

    await act(async () => {
      root?.render(<Harness />);
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(latest?.selectedLlmConfigId).toBeNull();
    expect(localStorageMock.removeItem).toHaveBeenCalledWith(
      "filework-selected-llm-config",
    );
  });

  it("routes image configs through executeTask instead of direct media IPC", async () => {
    const createdSession: ChatSession = {
      id: "session-image",
      workspacePath: "/workspace",
      title: "新对话",
      createdAt: "2026-06-23T09:00:00.000Z",
      updatedAt: "2026-06-23T09:00:00.000Z",
    };
    filework.createChatSession.mockResolvedValue(createdSession);
    filework.llmConfig.list.mockResolvedValue([
      {
        enabled: true,
        id: "image-cfg",
        lastCheckStatus: "success",
        modality: "image",
        modelAvailable: true,
      },
    ]);
    filework.llmConfig.get.mockResolvedValue({
      id: "image-cfg",
      modality: "image",
      model: "image-01",
    });
    filework.media.generateImage.mockResolvedValue({
      configId: "image-cfg",
      imageId: "img-1",
      path: "/tmp/generated.png",
      prompt: "画一张图",
    });

    const Harness = () => {
      latest = useChatSession("/workspace");
      return null;
    };

    await act(async () => {
      root?.render(<Harness />);
    });
    await act(async () => {
      latest?.setSelectedLlmConfigId("image-cfg");
    });
    await act(async () => {
      await latest?.handleSubmit({ text: "画一张图" });
    });

    await flushAnimationFrame();

    expect(filework.executeTask).toHaveBeenCalledWith(
      expect.objectContaining({
        llmConfigId: "image-cfg",
        prompt: "画一张图",
      }),
    );
    expect(filework.media.generateImage).not.toHaveBeenCalled();
    expect(filework.media.createVideoJob).not.toHaveBeenCalled();
  });

  it("defers task execution until after the submit UI has updated", async () => {
    filework.getChatSessions.mockResolvedValue([
      {
        id: "session-existing",
        workspacePath: "/workspace",
        title: "已有对话",
        createdAt: "2026-06-23T10:00:00.000Z",
        updatedAt: "2026-06-23T10:00:00.000Z",
      },
    ]);
    filework.getChatHistory.mockResolvedValue([
      {
        id: "user-old",
        sessionId: "session-existing",
        role: "user",
        content: "旧问题",
        timestamp: "2026-06-23T10:00:00.000Z",
      },
      {
        id: "assistant-old",
        sessionId: "session-existing",
        role: "assistant",
        content: "旧回答",
        parts: [{ type: "text", text: "旧回答" }],
        timestamp: "2026-06-23T10:00:01.000Z",
      },
    ]);

    const Harness = () => {
      latest = useChatSession("/workspace");
      return null;
    };

    await act(async () => {
      root?.render(<Harness />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      await latest?.handleSubmit({ text: "新问题" });
    });

    expect(latest?.input).toBe("");
    expect(latest?.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(filework.executeTask).not.toHaveBeenCalled();

    await flushAnimationFrame();

    expect(filework.executeTask).toHaveBeenCalledWith(
      expect.objectContaining({
        assistantMessageId: latest?.messages[3].id,
        history: expect.arrayContaining([
          expect.objectContaining({ content: "旧问题", role: "user" }),
          expect.objectContaining({ content: "新问题", role: "user" }),
        ]),
        prompt: "新问题",
        sessionId: "session-existing",
      }),
    );
  });

  it("reattaches a running task from the next unseen stream event after session switching", async () => {
    let streamEventCallback:
      | ((data: { id: string; channel: string; index: number }) => void)
      | null = null;
    filework.onStreamEvent.mockImplementation((callback) => {
      streamEventCallback = callback;
      return noop;
    });
    filework.getChatSessions.mockResolvedValue([
      {
        id: "session-reconnect",
        workspacePath: "/workspace",
        title: "重连会话",
        createdAt: "2026-06-23T11:00:00.000Z",
        updatedAt: "2026-06-23T11:00:00.000Z",
      },
      {
        id: "session-other",
        workspacePath: "/workspace",
        title: "另一个会话",
        createdAt: "2026-06-23T11:01:00.000Z",
        updatedAt: "2026-06-23T11:01:00.000Z",
      },
    ]);
    filework.getChatHistory.mockResolvedValue([]);
    filework.getActiveTask.mockImplementation((sessionId?: string) =>
      Promise.resolve(
        sessionId === "session-reconnect"
          ? {
              assistantMessageId: "assistant-reconnect",
              sessionId,
              streamEventCount: 10,
              taskId: "task-reconnect",
            }
          : null,
      ),
    );

    const Harness = () => {
      latest = useChatSession("/workspace");
      return null;
    };

    await act(async () => {
      root?.render(<Harness />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(filework.reattachTask).toHaveBeenCalledWith("task-reconnect", 0);

    act(() => {
      streamEventCallback?.({
        channel: "ai:stream-delta",
        id: "task-reconnect",
        index: 5,
      });
    });

    act(() => {
      latest?.handleSelectSession("session-other");
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    act(() => {
      latest?.handleSelectSession("session-reconnect");
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(filework.reattachTask).toHaveBeenLastCalledWith("task-reconnect", 6);
  });

  it("routes video configs through executeTask instead of direct media IPC", async () => {
    const createdSession: ChatSession = {
      id: "session-video",
      workspacePath: "/workspace",
      title: "新对话",
      createdAt: "2026-06-23T09:05:00.000Z",
      updatedAt: "2026-06-23T09:05:00.000Z",
    };
    filework.createChatSession.mockResolvedValue(createdSession);
    filework.llmConfig.list.mockResolvedValue([
      {
        enabled: true,
        id: "video-cfg",
        lastCheckStatus: "success",
        modality: "video",
        modelAvailable: true,
      },
    ]);
    filework.llmConfig.get.mockResolvedValue({
      id: "video-cfg",
      modality: "video",
      model: "video-01",
    });
    filework.media.createVideoJob.mockResolvedValue({
      configId: "video-cfg",
      jobId: "job-1",
      modelId: "video-01",
      prompt: "生成视频",
      status: "queued",
    });

    const Harness = () => {
      latest = useChatSession("/workspace");
      return null;
    };

    await act(async () => {
      root?.render(<Harness />);
    });
    await act(async () => {
      latest?.setSelectedLlmConfigId("video-cfg");
    });
    await act(async () => {
      await latest?.handleSubmit({ text: "生成视频" });
    });

    await flushAnimationFrame();

    expect(filework.executeTask).toHaveBeenCalledWith(
      expect.objectContaining({
        llmConfigId: "video-cfg",
        prompt: "生成视频",
      }),
    );
    expect(filework.media.createVideoJob).not.toHaveBeenCalled();
    expect(filework.media.generateImage).not.toHaveBeenCalled();
  });
});
