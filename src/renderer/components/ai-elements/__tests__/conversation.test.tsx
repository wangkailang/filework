import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "../conversation";

vi.mock("../../../i18n/i18n-react", () => ({
  useI18nContext: () => ({
    LL: {
      conv_newMessages: () => "新消息",
      conv_scrollToBottom: () => "滚动到底部",
    },
  }),
}));

describe("ConversationScrollButton", () => {
  let root: Root | null = null;

  beforeEach(() => {
    const { document, window } = parseHTML('<div id="root"></div>');
    vi.stubGlobal("window", window);
    vi.stubGlobal("document", document);
    vi.stubGlobal("HTMLElement", window.HTMLElement);
    vi.stubGlobal("MutationObserver", window.MutationObserver);
    window.HTMLElement.prototype.scrollTo = vi.fn();
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

  it("hides the scroll affordance when content no longer overflows", async () => {
    await act(async () => {
      root?.render(
        <Conversation>
          <ConversationContent>
            <div>message</div>
          </ConversationContent>
          <ConversationScrollButton />
        </Conversation>,
      );
    });

    const scrollEl = document.querySelector(
      ".overflow-y-auto",
    ) as HTMLDivElement | null;
    expect(scrollEl).not.toBeNull();
    setScrollMetrics(scrollEl as HTMLDivElement, {
      clientHeight: 300,
      scrollHeight: 900,
      scrollTop: 0,
    });

    await act(async () => {
      scrollEl?.dispatchEvent(new window.Event("scroll"));
    });
    const button = document.querySelector('button[aria-label="滚动到底部"]');
    expect(button).not.toBeNull();
    expect(button?.textContent).not.toContain("新消息");
    expect(button?.getAttribute("data-size")).toBe("icon");
    expect(button?.getAttribute("data-variant")).toBe("ghost");
    expect(button?.className).toContain("size-9");
    expect(button?.className).toContain("rounded-full");
    expect(button?.className).toContain("backdrop-blur-md");

    setScrollMetrics(scrollEl as HTMLDivElement, {
      clientHeight: 900,
      scrollHeight: 600,
      scrollTop: 0,
    });
    await act(async () => {
      root?.render(
        <Conversation>
          <ConversationContent>
            <div>message</div>
          </ConversationContent>
          <ConversationScrollButton />
        </Conversation>,
      );
    });

    expect(
      document.querySelector('button[aria-label="滚动到底部"]'),
    ).toBeNull();
  });
});

const setScrollMetrics = (
  el: HTMLDivElement,
  metrics: {
    clientHeight: number;
    scrollHeight: number;
    scrollTop: number;
  },
) => {
  Object.defineProperties(el, {
    clientHeight: { configurable: true, value: metrics.clientHeight },
    scrollHeight: { configurable: true, value: metrics.scrollHeight },
    scrollTop: { configurable: true, value: metrics.scrollTop },
  });
};
