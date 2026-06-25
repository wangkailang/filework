import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MessageActionFrame,
  MessageActions,
  MessageResponse,
  MessageSkillText,
  messageActionsHoverClass,
} from "../message";

describe("MessageResponse", () => {
  let root: Root | null = null;

  beforeEach(() => {
    const { document, window } = parseHTML('<div id="root"></div>');
    vi.stubGlobal("window", window);
    vi.stubGlobal("document", document);
    vi.stubGlobal("HTMLElement", window.HTMLElement);
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    root = createRoot(document.getElementById("root") as HTMLElement);
  });

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
    }
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    root = null;
  });

  it("renders markdown headings with compact chat typography", () => {
    const html = renderToStaticMarkup(
      <MessageResponse>
        {
          "## 第二步：重写引擎\n\n现在继续更新 levels.ts。\n\n- 写入文件\n- 运行检查"
        }
      </MessageResponse>,
    );

    expect(html).toContain('data-chat-heading="h2"');
    expect(html).toContain("text-[1.18rem]");
    expect(html).toContain("leading-7");
    expect(html).toContain("list-disc");
    expect(html).not.toContain("text-4xl");
    expect(html).not.toContain("text-3xl");
  });

  it("renders markdown tables with compact chat table styling", () => {
    const html = renderToStaticMarkup(
      <MessageResponse>
        {
          "| 日期 | 天气 | 气温 |\n| --- | --- | --- |\n| 6月14日 周日 | 阵雨、雷雨 | 26-29°C |\n| 6月15日 周一 | 上午雷雨，下午有雨 | 25-28°C |"
        }
      </MessageResponse>,
    );

    expect(html).toContain('data-chat-table-scroll="true"');
    expect(html).toContain('data-chat-table="true"');
    expect(html).toContain("<th");
    expect(html).toContain("border-b");
    expect(html).toContain("last:pr-0");
    expect(html).not.toContain("rounded-lg border");
  });

  it("expands message action hover through the message frame without adding an action row", () => {
    const html = renderToStaticMarkup(
      <MessageActionFrame from="user">
        <div>message bubble</div>
        <MessageActions className={messageActionsHoverClass}>
          <button type="button">copy</button>
        </MessageActions>
      </MessageActionFrame>,
    );

    expect(html).toContain("group/message-actions");
    expect(html).toContain("after:absolute");
    expect(html).toContain("after:top-full");
    expect(html).toContain("after:h-8");
    expect(html).toContain("after:min-w-16");
    expect(html).toContain("w-fit");
    expect(html).toContain("absolute");
    expect(html).toContain("top-full");
    expect(html).toContain("-translate-y-1/2");
    expect(html).toContain("rounded-lg");
    expect(html).toContain("bg-background/95");
    expect(html).toContain("shadow-sm");
    expect(html).toContain("z-20");
    expect(html).toContain("group-hover/message-actions:opacity-100");
  });

  it("renders inline file paths as compact clickable chips", () => {
    const html = renderToStaticMarkup(
      <MessageResponse workspacePath="/workspace/project">
        {
          "该页面位于 `frontend/app/[locale]/(no-layout)/content-filter-list/page.tsx`，常量 `CONTENT_FILTER_LIST` 保持普通代码。"
        }
      </MessageResponse>,
    );

    expect(html).toContain('data-chat-file-path="true"');
    expect(html).toContain(">page.tsx</span>");
    expect(html).not.toContain(">content-filter-list/page.tsx</span>");
    expect(html).toContain(
      'title="/workspace/project/frontend/app/[locale]/(no-layout)/content-filter-list/page.tsx"',
    );
    expect(html).toContain(
      'data-file-full-path="/workspace/project/frontend/app/[locale]/(no-layout)/content-filter-list/page.tsx"',
    );
    expect(html).toContain("CONTENT_FILTER_LIST");
    expect(html).toContain('data-streamdown="inline-code"');
  });

  it("dispatches open-file when an inline file path chip is clicked", async () => {
    const opened: string[] = [];
    window.addEventListener("filework:open-file", (event) => {
      const path = (event as CustomEvent<{ path?: string }>).detail?.path;
      if (path) opened.push(path);
    });

    await act(async () => {
      root?.render(
        <MessageResponse workspacePath="/workspace/project">
          {"查看 `src/renderer/components/ai-elements/message.tsx`。"}
        </MessageResponse>,
      );
    });

    const button = document.querySelector(
      '[data-chat-file-path="true"]',
    ) as HTMLButtonElement | null;
    expect(button?.textContent).toContain("message.tsx");

    await act(async () => {
      button?.click();
    });

    expect(opened).toEqual([
      "/workspace/project/src/renderer/components/ai-elements/message.tsx",
    ]);
  });

  it("renders local markdown file links with the same compact path chip", () => {
    const html = renderToStaticMarkup(
      <MessageResponse workspacePath="/workspace/project">
        {
          "核心改动在 [message.tsx](src/renderer/components/ai-elements/message.tsx:188)。"
        }
      </MessageResponse>,
    );

    expect(html).toContain('data-chat-file-path="true"');
    expect(html).toContain(">message.tsx</span>");
    expect(html).not.toContain("message.tsx (line 188)");
    expect(html).toContain(
      'title="/workspace/project/src/renderer/components/ai-elements/message.tsx:188"',
    );
    expect(html).not.toContain('href="src/renderer/components');
  });
});

describe("MessageSkillText", () => {
  it("renders leading slash skills as lightweight chips without command slashes", () => {
    const html = renderToStaticMarkup(
      <MessageSkillText text="/pdf-processor /algorithmic-art summarize this" />,
    );

    expect(html).toContain('data-skill-mention=""');
    expect(html).toContain('data-skill-id="pdf-processor"');
    expect(html).toContain('data-skill-id="algorithmic-art"');
    expect(html).toContain(">pdf-processor</span>");
    expect(html).toContain(">algorithmic-art</span>");
    expect(html).not.toContain(">/pdf-processor</span>");
    expect(html).not.toContain(">/algorithmic-art</span>");
    expect(html).toContain("summarize this");
  });

  it("does not chip slash text inside ordinary prose", () => {
    const html = renderToStaticMarkup(
      <MessageSkillText text="please use /pdf-processor" />,
    );

    expect(html).not.toContain("data-skill-mention");
    expect(html).toContain("please use /pdf-processor");
  });

  it("does not chip leading filesystem paths", () => {
    const html = renderToStaticMarkup(
      <MessageSkillText text="/Users/kailang/project" />,
    );

    expect(html).not.toContain("data-skill-mention");
    expect(html).toContain("/Users/kailang/project");
  });
});
