import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MediaImageCard } from "../MediaImageCard";
import type { ImagePart } from "../types";

const imagePart: ImagePart = {
  type: "image",
  path: "/tmp/generated/saas-cache.png",
  prompt: "给 saas 缓存策略文章生成与一张图",
  configId: "image-config",
  imageId: "image-1",
  modelId: "gpt-image-2",
};

describe("MediaImageCard", () => {
  it("keeps generated image cards sized to their image instead of stretching across the chat", () => {
    const html = renderToStaticMarkup(<MediaImageCard part={imagePart} />);

    expect(html).toContain("inline-flex");
    expect(html).toContain("w-fit");
    expect(html).toContain("flex-col");
    expect(html).toContain("self-start");
    expect(html).toContain("object-contain");
    expect(html).toContain("max-h-[520px]");
    expect(html).toContain("border-t");
    expect(html).not.toContain("block w-full");
  });
});
