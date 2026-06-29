import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ImageDownloadButton } from "../ImageLightbox";

describe("ImageDownloadButton", () => {
  it("links directly to the previewed image with a download filename", () => {
    const html = renderToStaticMarkup(
      <ImageDownloadButton
        src="local-file:///tmp/generated/saas-cache.png"
        downloadName="saas-cache.png"
      />,
    );

    expect(html).toContain('aria-label="下载图片"');
    expect(html).toContain('href="local-file:///tmp/generated/saas-cache.png"');
    expect(html).toContain('download="saas-cache.png"');
  });
});
