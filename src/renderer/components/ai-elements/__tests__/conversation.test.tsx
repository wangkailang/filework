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
    Object.defineProperties(window.HTMLElement.prototype, {
      clientHeight: { configurable: true, writable: true, value: 0 },
      scrollHeight: { configurable: true, writable: true, value: 0 },
      scrollTop: { configurable: true, writable: true, value: 0 },
    });
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

  it("keeps following streaming content when it was at the bottom before the content grew", async () => {
    await act(async () => {
      root?.render(
        <Conversation>
          <ConversationContent>
            <div>partial response</div>
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
      scrollHeight: 600,
      scrollTop: 300,
    });
    await act(async () => {
      scrollEl?.dispatchEvent(new window.Event("scroll"));
    });
    vi.mocked(window.HTMLElement.prototype.scrollTo).mockClear();

    setScrollMetrics(scrollEl as HTMLDivElement, {
      clientHeight: 300,
      scrollHeight: 900,
      scrollTop: 300,
    });
    await act(async () => {
      root?.render(
        <Conversation>
          <ConversationContent>
            <div>partial response with a newly rendered markdown block</div>
          </ConversationContent>
          <ConversationScrollButton />
        </Conversation>,
      );
    });

    expect(window.HTMLElement.prototype.scrollTo).toHaveBeenCalledWith({
      top: 900,
      behavior: "smooth",
    });
    expect(
      document.querySelector('button[aria-label="滚动到底部"]'),
    ).toBeNull();

    vi.mocked(window.HTMLElement.prototype.scrollTo).mockClear();
    setScrollMetrics(scrollEl as HTMLDivElement, {
      clientHeight: 300,
      scrollHeight: 900,
      scrollTop: 450,
    });
    await act(async () => {
      scrollEl?.dispatchEvent(new window.Event("scroll"));
    });
    setScrollMetrics(scrollEl as HTMLDivElement, {
      clientHeight: 300,
      scrollHeight: 1_100,
      scrollTop: 450,
    });
    await act(async () => {
      root?.render(
        <Conversation>
          <ConversationContent>
            <div>partial response with two newly rendered markdown blocks</div>
          </ConversationContent>
          <ConversationScrollButton />
        </Conversation>,
      );
    });

    expect(window.HTMLElement.prototype.scrollTo).toHaveBeenCalledWith({
      top: 1_100,
      behavior: "smooth",
    });
  });

  it("does not follow streaming content after the user scrolls upward", async () => {
    await act(async () => {
      root?.render(
        <Conversation>
          <ConversationContent>
            <div>partial response</div>
          </ConversationContent>
        </Conversation>,
      );
    });

    const scrollEl = document.querySelector(
      ".overflow-y-auto",
    ) as HTMLDivElement | null;
    setScrollMetrics(scrollEl as HTMLDivElement, {
      clientHeight: 300,
      scrollHeight: 900,
      scrollTop: 600,
    });
    await act(async () => {
      scrollEl?.dispatchEvent(new window.Event("scroll"));
    });
    setScrollMetrics(scrollEl as HTMLDivElement, {
      clientHeight: 300,
      scrollHeight: 900,
      scrollTop: 300,
    });
    await act(async () => {
      scrollEl?.dispatchEvent(new window.Event("scroll"));
    });
    vi.mocked(window.HTMLElement.prototype.scrollTo).mockClear();

    setScrollMetrics(scrollEl as HTMLDivElement, {
      clientHeight: 300,
      scrollHeight: 1_100,
      scrollTop: 300,
    });
    await act(async () => {
      root?.render(
        <Conversation>
          <ConversationContent>
            <div>partial response with more markdown</div>
          </ConversationContent>
        </Conversation>,
      );
    });

    expect(window.HTMLElement.prototype.scrollTo).not.toHaveBeenCalled();
  });

  it("does not jump to newly appended children after the user scrolls upward", async () => {
    await act(async () => {
      root?.render(
        <Conversation>
          <ConversationContent>
            <div key="message-1">first message</div>
          </ConversationContent>
        </Conversation>,
      );
    });

    const scrollEl = document.querySelector(
      ".overflow-y-auto",
    ) as HTMLDivElement | null;
    setScrollMetrics(scrollEl as HTMLDivElement, {
      clientHeight: 300,
      scrollHeight: 900,
      scrollTop: 600,
    });
    await act(async () => {
      scrollEl?.dispatchEvent(new window.Event("scroll"));
    });
    setScrollMetrics(scrollEl as HTMLDivElement, {
      clientHeight: 300,
      scrollHeight: 900,
      scrollTop: 250,
    });
    await act(async () => {
      scrollEl?.dispatchEvent(new window.Event("scroll"));
    });
    vi.mocked(window.HTMLElement.prototype.scrollTo).mockClear();

    setScrollMetrics(scrollEl as HTMLDivElement, {
      clientHeight: 300,
      scrollHeight: 1_100,
      scrollTop: 250,
    });
    await act(async () => {
      root?.render(
        <Conversation>
          <ConversationContent>
            <div key="message-1">first message</div>
            <div key="message-2">new message</div>
          </ConversationContent>
        </Conversation>,
      );
    });

    expect(window.HTMLElement.prototype.scrollTo).not.toHaveBeenCalled();
  });

  it("scrolls to the bottom when a newly submitted user message changes the request key", async () => {
    await act(async () => {
      root?.render(
        <Conversation>
          <ConversationContent scrollToBottomKey="user-message-1">
            <div>existing conversation</div>
          </ConversationContent>
        </Conversation>,
      );
    });

    const scrollEl = document.querySelector(
      ".overflow-y-auto",
    ) as HTMLDivElement | null;
    setScrollMetrics(scrollEl as HTMLDivElement, {
      clientHeight: 300,
      scrollHeight: 900,
      scrollTop: 600,
    });
    await act(async () => {
      scrollEl?.dispatchEvent(new window.Event("scroll"));
    });
    setScrollMetrics(scrollEl as HTMLDivElement, {
      clientHeight: 300,
      scrollHeight: 900,
      scrollTop: 250,
    });
    await act(async () => {
      scrollEl?.dispatchEvent(new window.Event("scroll"));
    });
    vi.mocked(window.HTMLElement.prototype.scrollTo).mockClear();

    setScrollMetrics(scrollEl as HTMLDivElement, {
      clientHeight: 300,
      scrollHeight: 1_100,
      scrollTop: 250,
    });
    await act(async () => {
      root?.render(
        <Conversation>
          <ConversationContent scrollToBottomKey="user-message-2">
            <div>existing conversation</div>
          </ConversationContent>
        </Conversation>,
      );
    });

    expect(window.HTMLElement.prototype.scrollTo).toHaveBeenCalledWith({
      top: 1_100,
      behavior: "smooth",
    });
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
