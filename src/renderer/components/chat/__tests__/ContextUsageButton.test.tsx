import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ContextUsageButton } from "../ContextUsageButton";

describe("ContextUsageButton", () => {
  it("renders circular progress trigger with key context details in tooltip", () => {
    const html = renderToStaticMarkup(
      <ContextUsageButton
        usage={{
          contextWindow: 258_000,
          maxOutputTokens: 8_192,
          originalTokens: 183_000,
          safetyMargin: 2_000,
          tokenBudget: 247_808,
        }}
      />,
    );
    const buttonHtml = html.match(/<button[^>]*>([\s\S]*?)<\/button>/)?.[1];

    expect(buttonHtml).toContain('data-context-usage-ring="true"');
    expect(buttonHtml).toContain('data-context-usage-percent="71"');
    expect(buttonHtml).not.toContain("71%");
    expect(buttonHtml).not.toContain("lucide-gauge");
    expect(html).toContain("71% 已用");
    expect(html).toContain("已用 183k 标记，共 258k");
    expect(html).not.toContain("背景信息窗口");
    expect(html).not.toContain("可输入预算");
  });

  it("caps the circular percentage at 100% while keeping actual token counts", () => {
    const html = renderToStaticMarkup(
      <ContextUsageButton
        usage={{
          contextWindow: 32_000,
          maxOutputTokens: 8_192,
          originalTokens: 34_000,
          safetyMargin: 2_000,
          tokenBudget: 21_808,
        }}
      />,
    );
    const buttonHtml = html.match(/<button[^>]*>([\s\S]*?)<\/button>/)?.[1];

    expect(buttonHtml).toContain('data-context-usage-percent="100"');
    expect(buttonHtml).not.toContain("100%");
    expect(html).not.toContain("106%");
    expect(html).not.toContain("154%");
    expect(html).toContain("100% 已用");
    expect(html).toContain("已用 34k 标记，共 32k");
    expect(html).not.toContain("背景信息窗口");
  });

  it("renders a compact hover tooltip with only key context numbers", () => {
    const html = renderToStaticMarkup(
      <ContextUsageButton
        usage={{
          contextWindow: 32_000,
          maxOutputTokens: 8_192,
          originalTokens: 34_000,
          safetyMargin: 2_000,
          tokenBudget: 21_808,
        }}
      />,
    );

    expect(html).toContain("data-context-usage-tooltip");
    expect(html).not.toContain("背景信息窗口");
    expect(html).toContain("100% 已用");
    expect(html).toContain("已用 34k 标记，共 32k");
    expect(html).not.toContain("预留输出");
    expect(html).not.toContain("安全余量");
  });

  it("marks estimated context usage without marking actual provider usage", () => {
    const estimatedHtml = renderToStaticMarkup(
      <ContextUsageButton
        usage={{
          accuracy: "estimated",
          contextWindow: 258_000,
          originalTokens: 12_000,
          tokenBudget: 247_808,
        }}
      />,
    );
    expect(estimatedHtml).toContain("5% 已用（估算）");
    expect(estimatedHtml).toContain(">估算</span>");

    const actualHtml = renderToStaticMarkup(
      <ContextUsageButton
        usage={{
          accuracy: "actual",
          contextWindow: 258_000,
          cumulativeInputTokens: 69_200,
          originalTokens: 34_300,
          tokenBudget: 247_808,
        }}
      />,
    );
    expect(actualHtml).toContain("13% 已用");
    expect(actualHtml).toContain("已用 34k 标记，共 258k");
    expect(actualHtml).toContain("累计输入 69k 标记");
    expect(actualHtml).not.toContain("估算");
    expect(actualHtml).not.toContain("背景信息窗口");
  });

  it("shows provider-native compaction status when enabled", () => {
    const html = renderToStaticMarkup(
      <ContextUsageButton
        usage={{
          accuracy: "actual",
          contextWindow: 200_000,
          originalTokens: 170_000,
          providerNativeCompaction: {
            enabled: true,
            mode: "anthropic-context-management-compact",
            provider: "anthropic",
            triggerTokens: 170_000,
          },
          tokenBudget: 190_000,
        }}
      />,
    );

    expect(html).toContain("85% 已用");
    expect(html).toContain("原生压缩已启用：Anthropic");
  });

  it("shows selected model context before usage arrives", () => {
    const html = renderToStaticMarkup(
      <ContextUsageButton
        usage={{
          contextWindow: 258_000,
          originalTokens: 0,
          tokenBudget: null,
        }}
      />,
    );
    const buttonHtml = html.match(/<button[^>]*>([\s\S]*?)<\/button>/)?.[1];

    expect(buttonHtml).toContain('data-context-usage-percent="0"');
    expect(buttonHtml).not.toContain("0%");
    expect(html).toContain("0% 已用");
    expect(html).toContain("已用 0 标记，共 258k");
    expect(html).not.toContain("背景信息窗口");
    expect(html).not.toContain("发送后更新");
  });
});
