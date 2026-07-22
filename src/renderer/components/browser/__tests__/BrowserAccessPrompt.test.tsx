import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../i18n/i18n-react", () => ({
  useI18nContext: () => ({
    LL: {
      browserApproval_allowOnce: () => "允许一次",
      browserApproval_alwaysAllow: () => "始终允许此站点",
      browserApproval_approveOnce: () => "批准本次",
      browserApproval_block: () => "阻止",
      browserApproval_deny: () => "拒绝",
      browserApproval_originTitle: () => "允许 Agent 访问此站点？",
      browserApproval_sensitiveTitle: () => "批准网页敏感操作？",
    },
  }),
}));

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
