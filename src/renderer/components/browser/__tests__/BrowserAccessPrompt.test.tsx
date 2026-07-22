import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { BrowserAccessPrompt } from "../BrowserAccessPrompt";

describe("BrowserAccessPrompt", () => {
  it("offers once, always, and block only for origin access", () => {
    const html = renderToStaticMarkup(
      <BrowserAccessPrompt
        request={{
          requestId: "request-1",
          taskId: "task-1",
          kind: "origin",
          origin: "https://example.com",
        }}
        onRespond={vi.fn()}
      />,
    );

    expect(html).toContain("https://example.com");
    expect(html).toContain("允许一次");
    expect(html).toContain("始终允许此站点");
    expect(html).toContain("阻止");
  });

  it("does not offer persistent approval for sensitive actions", () => {
    const html = renderToStaticMarkup(
      <BrowserAccessPrompt
        request={{
          requestId: "request-2",
          taskId: "task-1",
          kind: "sensitive-action",
          origin: "https://shop.example.com",
          action: {
            type: "click",
            target: "Buy now",
            risk: "external-effect",
          },
        }}
        onRespond={vi.fn()}
      />,
    );

    expect(html).toContain("Buy now");
    expect(html).toContain("批准本次");
    expect(html).toContain("拒绝");
    expect(html).not.toContain("始终允许此站点");
  });
});
