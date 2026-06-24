import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TooltipProvider } from "../../ui/tooltip";
import {
  buildLlmConfigStatusTooltip,
  getLlmConfigModalityBadge,
  LlmConfigStatusIndicator,
} from "../LlmConfigPanel";

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

  it("includes the connection test time in status tooltip copy", () => {
    const checkedAt = "2026-06-22T10:30:00.000Z";
    const formattedCheckedAt = new Intl.DateTimeFormat("zh-CN", {
      dateStyle: "medium",
      hour12: false,
      timeStyle: "short",
    }).format(new Date(checkedAt));
    const LL = {
      llmConfig_lastTestedAt: ({ when }: { when: string }) => `测试于 ${when}`,
      llmConfig_statusSuccess: () => "连接正常",
      llmConfig_statusUnchecked: () => "尚未测试连接",
    };

    expect(
      buildLlmConfigStatusTooltip(
        {
          lastCheckedAt: checkedAt,
          lastCheckMessage: null,
          lastCheckStatus: "success",
        },
        LL,
        "zh-CN",
      ),
    ).toEqual(["连接正常", `测试于 ${formattedCheckedAt}`]);
  });
});

describe("getLlmConfigModalityBadge", () => {
  it("shows IMAGE for legacy custom gpt-image configs saved as chat", () => {
    expect(
      getLlmConfigModalityBadge({
        provider: "custom",
        model: "gpt-image-2",
        modality: "chat",
      }),
    ).toBe("image");
  });

  it("does not show a badge for regular chat configs", () => {
    expect(
      getLlmConfigModalityBadge({
        provider: "custom",
        model: "gpt-5.5",
        modality: "chat",
      }),
    ).toBeNull();
  });
});
