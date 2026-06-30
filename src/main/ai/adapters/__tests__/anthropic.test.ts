import { describe, expect, it, vi } from "vitest";

vi.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: vi.fn(() => vi.fn()),
}));

import { AnthropicAdapter } from "../anthropic";

describe("AnthropicAdapter provider options", () => {
  it("enables native context-management compaction", () => {
    const adapter = new AnthropicAdapter();

    expect(
      adapter.buildProviderOptions({
        provider: "anthropic",
        apiKey: "test-key",
        model: "claude-sonnet-4-5",
        compressionTriggerBudget: 170_000,
      }),
    ).toEqual({
      anthropic: {
        cacheControl: { type: "ephemeral" },
        disableParallelToolUse: true,
        contextManagement: {
          edits: [
            {
              type: "compact_20260112",
              trigger: { type: "input_tokens", value: 170_000 },
              pauseAfterCompaction: false,
            },
          ],
        },
      },
    });
  });
});
