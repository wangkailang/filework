import { parseHTML } from "linkedom";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";

const chat = vi.hoisted(() => ({
  handleNewChat: vi.fn(),
  handleSelectSession: vi.fn(),
  sessions: [
    {
      id: "session-1",
      title: "修复登录流程",
      workspacePath: "/workspace",
      createdAt: "2026-07-24T08:00:00.000Z",
      updatedAt: "2026-07-24T08:00:00.000Z",
    },
  ],
}));

let changeCommandQuery: ((value: string) => void) | null = null;

vi.mock("../../chat/ChatSessionProvider", () => ({
  useChatSessionLite: () => chat,
}));

vi.mock("../../../i18n/i18n-react", () => ({
  useI18nContext: () => ({
    LL: {
      cmdk_actions: () => "操作",
      cmdk_empty: () => "没有匹配结果",
      cmdk_files: () => "文件",
      cmdk_placeholder: () => "搜索任务、文件或操作…",
      cmdk_searching: () => "正在搜索文件…",
      cmdk_switchWorkspace: () => "切换工作区",
      cmdk_tasks: () => "任务",
      dock_diff: () => "变更",
      dock_preview: () => "预览",
      dock_search: () => "搜索",
      dock_subagent: () => "子智能体",
      dock_trash: () => "回收站",
      dock_web: () => "网页",
      session_newChat: () => "新对话",
      topbar_settings: () => "设置",
    },
  }),
}));

vi.mock("../../ui/command", () => ({
  Command: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CommandDialog: ({
    children,
    open,
  }: {
    children: ReactNode;
    open: boolean;
  }) => (open ? <div data-testid="palette">{children}</div> : null),
  CommandEmpty: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  CommandGroup: ({
    children,
    heading,
  }: {
    children: ReactNode;
    heading?: string;
  }) => (
    <section>
      <h2>{heading}</h2>
      {children}
    </section>
  ),
  CommandInput: ({
    onValueChange,
    placeholder,
  }: {
    onValueChange?: (value: string) => void;
    placeholder?: string;
  }) => {
    changeCommandQuery = onValueChange ?? null;
    return <input aria-label={placeholder} />;
  },
  CommandItem: ({
    children,
    onSelect,
  }: {
    children: ReactNode;
    onSelect?: () => void;
  }) => (
    <button type="button" onClick={onSelect}>
      {children}
    </button>
  ),
  CommandList: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CommandShortcut: ({ children }: { children: ReactNode }) => (
    <kbd>{children}</kbd>
  ),
}));

import { CommandPalette } from "../CommandPalette";

const openPalette = async (window: Window) => {
  await act(async () => {
    const event = window.document.createEvent("Event");
    event.initEvent("keydown", true, true);
    Object.assign(event, { metaKey: true, key: "k", shiftKey: false });
    window.dispatchEvent(event);
  });
};

describe("CommandPalette", () => {
  let root: Root | null = null;
  let searchFiles: ReturnType<typeof vi.fn>;
  let onOpenFile: Mock<(path: string) => void>;

  beforeEach(() => {
    vi.useFakeTimers();
    const parsed = parseHTML('<div id="root"></div>');
    searchFiles = vi.fn(() =>
      Promise.resolve({
        hits: [
          {
            name: "README.md",
            relPath: "docs/README.md",
            size: 1200,
            mtimeMs: 1,
            score: 10,
          },
        ],
        totalMatched: 1,
        truncated: false,
      }),
    );
    Object.assign(parsed.window, {
      filework: { searchFiles },
    });
    vi.stubGlobal("window", parsed.window);
    vi.stubGlobal("document", parsed.document);
    vi.stubGlobal("HTMLElement", parsed.window.HTMLElement);
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    onOpenFile = vi.fn<(path: string) => void>();
    root = createRoot(parsed.document.getElementById("root") as HTMLElement);
    changeCommandQuery = null;
    vi.clearAllMocks();
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const renderPalette = async () => {
    await act(async () => {
      root?.render(
        <CommandPalette
          isGitRepo={true}
          hasSubagent={false}
          onOpenDockTab={vi.fn()}
          onOpenFile={onOpenFile}
          onOpenSettings={vi.fn()}
          onSwitchWorkspace={vi.fn()}
          workspaceRoot="/workspace"
        />,
      );
    });
  };

  it("quickly opens an existing task from the same palette as actions", async () => {
    await renderPalette();
    await openPalette(window);

    expect(document.getElementById("root")?.textContent).toContain("任务");
    const taskButton = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("修复登录流程"),
    );
    expect(taskButton).toBeTruthy();

    await act(async () => {
      taskButton?.dispatchEvent(new window.Event("click", { bubbles: true }));
    });
    expect(chat.handleSelectSession).toHaveBeenCalledWith("session-1");
  });

  it("searches workspace files and opens a selected match", async () => {
    await renderPalette();
    await openPalette(window);

    await act(async () => {
      changeCommandQuery?.("readme");
    });
    await act(async () => {
      vi.advanceTimersByTime(200);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(searchFiles).toHaveBeenCalledWith("/workspace", "readme", {
      limit: 8,
    });
    const fileButton = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("docs/README.md"),
    );
    expect(fileButton).toBeTruthy();

    await act(async () => {
      fileButton?.dispatchEvent(new window.Event("click", { bubbles: true }));
    });
    expect(onOpenFile).toHaveBeenCalledWith("/workspace/docs/README.md");
  });
});
