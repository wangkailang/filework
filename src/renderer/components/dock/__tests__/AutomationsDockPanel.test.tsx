import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const chatMock = vi.hoisted(() => ({
  value: {
    activeSessionId: null as string | null,
    handleOpenAutomationRun: vi.fn(),
    handleTriggerAutomationRun: vi.fn(),
    sessions: [] as Array<{
      automationRun?: { automationId: string; id: string; title: string };
      id: string;
      title: string;
    }>,
    transientAutomationRun: null as null | {
      automationId: string;
      id: string;
      title: string;
    },
  },
}));

const panelMock = vi.hoisted(() => ({
  latestProps: null as null | {
    activeAutomationId?: string | null;
    activeAutomationRunId?: string | null;
    onOpenRunDetails?: (run: unknown) => void;
  },
  run: {
    automationId: "auto-2",
    automationTitle: "Active automation",
    chatSessionId: "session-automation",
    id: "run-2",
  },
}));

vi.mock("../../chat/ChatSessionProvider", () => ({
  useChatSessionLite: () => chatMock.value,
}));

vi.mock("../../settings/AutomationsPanel", () => ({
  AutomationsPanel: (props: {
    activeAutomationId?: string | null;
    activeAutomationRunId?: string | null;
    onOpenRunDetails?: (run: unknown) => void;
  }) => {
    panelMock.latestProps = props;
    return (
      <button
        type="button"
        data-open-run-details="true"
        onClick={() => props.onOpenRunDetails?.(panelMock.run)}
      >
        查看详情
      </button>
    );
  },
}));

import { AutomationsDockPanel } from "../AutomationsDockPanel";

describe("AutomationsDockPanel", () => {
  type TestWindow = Window & {
    Event: typeof Event;
    HTMLElement: typeof HTMLElement;
  };

  let root: Root | null = null;
  let document: Document;
  let domWindow: TestWindow;

  beforeEach(() => {
    const parsed = parseHTML('<!doctype html><div id="root"></div>');
    document = parsed.document;
    domWindow = parsed.window as unknown as TestWindow;
    vi.stubGlobal("window", domWindow);
    vi.stubGlobal("document", document);
    vi.stubGlobal("HTMLElement", domWindow.HTMLElement);
    vi.stubGlobal("Event", domWindow.Event);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    root = createRoot(document.getElementById("root") as HTMLElement);
    panelMock.latestProps = null;
    chatMock.value.activeSessionId = "session-automation";
    chatMock.value.transientAutomationRun = null;
    chatMock.value.sessions = [
      {
        automationRun: {
          automationId: "auto-2",
          id: "run-2",
          title: "Active automation",
        },
        id: "session-automation",
        title: "Active automation",
      },
    ];
    chatMock.value.handleOpenAutomationRun.mockReset();
    chatMock.value.handleTriggerAutomationRun.mockReset();
  });

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
    }
    vi.unstubAllGlobals();
    root = null;
  });

  it("passes the active automation run id into the panel for row highlighting", async () => {
    await act(async () => {
      root?.render(<AutomationsDockPanel />);
    });

    expect(panelMock.latestProps?.activeAutomationId).toBe("auto-2");
    expect(panelMock.latestProps?.activeAutomationRunId).toBe("run-2");
  });

  it("prefers the transient automation run for row highlighting", async () => {
    chatMock.value.activeSessionId = null;
    chatMock.value.sessions = [];
    chatMock.value.transientAutomationRun = {
      automationId: "auto-transient",
      id: "run-transient",
      title: "Transient automation",
    };

    await act(async () => {
      root?.render(<AutomationsDockPanel />);
    });

    expect(panelMock.latestProps?.activeAutomationId).toBe("auto-transient");
    expect(panelMock.latestProps?.activeAutomationRunId).toBe("run-transient");
  });

  it("opens chat-backed run details in the center chat and notifies the host", async () => {
    const onOpenChatDetails = vi.fn();
    chatMock.value.handleOpenAutomationRun.mockReturnValue(true);

    await act(async () => {
      root?.render(
        <AutomationsDockPanel onOpenChatDetails={onOpenChatDetails} />,
      );
    });

    const button = document.querySelector(
      '[data-open-run-details="true"]',
    ) as HTMLElement | null;

    await act(async () => {
      button?.dispatchEvent(new domWindow.Event("click", { bubbles: true }));
    });

    expect(chatMock.value.handleOpenAutomationRun).toHaveBeenCalledWith(
      panelMock.run,
    );
    expect(onOpenChatDetails).toHaveBeenCalledTimes(1);
  });
});
