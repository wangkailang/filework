import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ImageGallery } from "../ImageGallery";
import type { ImageGalleryPart } from "../types";

const galleryPart: ImageGalleryPart = {
  type: "image-gallery",
  source: "web-fetch",
  context: "https://github.com/openai/codex",
  images: [
    {
      url: "https://example.com/one.png",
      sourceUrl: "https://github.com/openai/codex",
    },
    {
      url: "https://example.com/two.png",
      sourceUrl: "https://github.com/openai/codex",
    },
  ],
};

describe("ImageGallery", () => {
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

  it("starts collapsed with a concise page-image header and no images rendered", () => {
    const html = renderToStaticMarkup(<ImageGallery part={galleryPart} />);

    expect(html).toContain("页面图片 · github.com");
    expect(html).toContain("2 张图片");
    expect(html).toContain("展开");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("<img");
    expect(html).not.toContain("https://example.com/one.png");
  });

  it("renders gallery images only after the header is expanded", async () => {
    await act(async () => {
      root?.render(<ImageGallery part={galleryPart} />);
    });

    expect(document.querySelectorAll("img")).toHaveLength(0);

    const toggle = document.querySelector(
      'button[aria-expanded="false"]',
    ) as HTMLButtonElement | null;

    await act(async () => {
      toggle?.click();
    });

    expect(
      document.querySelector('button[aria-expanded="true"]'),
    ).not.toBeNull();
    expect(document.querySelectorAll("img")).toHaveLength(2);
  });
});
