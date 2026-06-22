import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatSession } from "../types";

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

const noop = () => undefined;
const off = () => noop;

const createFileworkMock = () => ({
  answerClarification: vi.fn(),
  approvePlan: vi.fn(),
  approveSkill: vi.fn(),
  approveToolCall: vi.fn(),
  approveToolCallBatch: vi.fn(),
  automations: {
    prepareChatRun: vi.fn(),
  },
  cancelPlan: vi.fn(),
  createChatSession: vi.fn(),
  deleteChatSession: vi.fn(),
  executeTask: vi.fn(() => Promise.resolve()),
  forkChatSession: vi.fn(),
  getActiveTask: vi.fn(() => Promise.resolve(null)),
  getActiveTasks: vi.fn(() => Promise.resolve([])),
  getChatHistory: vi.fn(() => Promise.resolve([])),
  getChatSessions: vi.fn(() => Promise.resolve([])),
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
    Object.assign(window, { filework, localStorage: localStorageMock });
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
});
