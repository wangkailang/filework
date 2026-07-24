import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppErrorBoundary } from "../AppErrorBoundary";

const BrokenView = () => {
  throw new Error("renderer failed");
};

describe("AppErrorBoundary", () => {
  let root: Root | null = null;

  beforeEach(() => {
    const { document, window } = parseHTML('<div id="root"></div>');
    vi.stubGlobal("window", window);
    vi.stubGlobal("document", document);
    vi.stubGlobal("HTMLElement", window.HTMLElement);
    vi.spyOn(console, "error").mockImplementation(() => {});
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    root = createRoot(document.getElementById("root") as HTMLElement);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("replaces a renderer crash with a localized, reloadable recovery view", async () => {
    const reload = vi.fn();

    await act(async () => {
      root?.render(
        <AppErrorBoundary locale="zh-CN" onReload={reload}>
          <BrokenView />
        </AppErrorBoundary>,
      );
    });

    expect(document.getElementById("root")?.textContent).toContain(
      "工作区暂时无法显示",
    );
    expect(document.getElementById("root")?.textContent).toContain(
      "文件和对话仍保存在本地",
    );
    const button = document.querySelector('button[aria-label="重新加载应用"]');
    expect(button).toBeTruthy();

    await act(async () => {
      button?.dispatchEvent(new window.Event("click", { bubbles: true }));
    });
    expect(reload).toHaveBeenCalledOnce();
  });
});
