import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TooltipProvider } from "../../ui/tooltip";
import { LlmConfigStatusIndicator } from "../LlmConfigPanel";

describe("LlmConfigStatusIndicator", () => {
  it("uses a portal-backed tooltip instead of inline clipped hover content", () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <LlmConfigStatusIndicator
          busy={false}
          label="HTTP 401: bad key"
          status="error"
        />
      </TooltipProvider>,
    );

    expect(html).toContain('aria-label="HTTP 401: bad key"');
    expect(html).toContain('data-slot="tooltip-trigger"');
    expect(html).not.toContain("group-hover:opacity-100");
  });
});
