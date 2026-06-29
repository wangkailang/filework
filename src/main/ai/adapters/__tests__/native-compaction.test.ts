import { describe, expect, it } from "vitest";
import {
  buildProviderNativeCompactionOptions,
  extractProviderNativeCompactionUsage,
  getProviderNativeCompaction,
} from "../native-compaction";

describe("provider native compaction", () => {
  it("enables OpenAI Responses native truncation only for official OpenAI configs", () => {
    const config = {
      provider: "openai",
      apiKey: "test-key",
      baseUrl: null,
      model: "gpt-5.5",
      modelCapabilities: {
        preferredApi: "responses" as const,
        supportsReasoning: true,
        supportsTools: true,
        supportsVision: true,
      },
      compressionTriggerBudget: 219_300,
    };

    expect(getProviderNativeCompaction(config)).toEqual({
      enabled: true,
      mode: "openai-truncation-auto",
      provider: "openai",
      triggerTokens: null,
    });
    expect(buildProviderNativeCompactionOptions(config)).toEqual({
      openai: { truncation: "auto" },
    });
  });

  it("does not send OpenAI native truncation to OpenAI-compatible custom endpoints", () => {
    const config = {
      provider: "custom",
      apiKey: "test-key",
      baseUrl: "https://api.example.com/v1",
      model: "gpt-5.5",
      modelCapabilities: {
        preferredApi: "responses" as const,
        supportsReasoning: true,
        supportsTools: true,
        supportsVision: true,
      },
      compressionTriggerBudget: 219_300,
    };

    expect(getProviderNativeCompaction(config)).toEqual({
      enabled: false,
      provider: "custom",
      reason: "unsupported-provider",
    });
    expect(buildProviderNativeCompactionOptions(config)).toEqual({});
  });

  it("does not send OpenAI native truncation when OpenAI is pointed at a custom endpoint", () => {
    const config = {
      provider: "openai",
      apiKey: "test-key",
      baseUrl: "https://gateway.example.com/v1",
      model: "gpt-5.5",
      modelCapabilities: {
        preferredApi: "responses" as const,
        supportsReasoning: true,
        supportsTools: true,
        supportsVision: true,
      },
      compressionTriggerBudget: 219_300,
    };

    expect(getProviderNativeCompaction(config)).toEqual({
      enabled: false,
      provider: "openai",
      reason: "unsupported-provider",
    });
    expect(buildProviderNativeCompactionOptions(config)).toEqual({});
  });

  it("enables Anthropic context-management compaction with the local trigger budget", () => {
    const config = {
      provider: "anthropic",
      apiKey: "test-key",
      model: "claude-sonnet-4-5",
      compressionTriggerBudget: 170_000,
    };

    expect(getProviderNativeCompaction(config)).toEqual({
      enabled: true,
      mode: "anthropic-context-management-compact",
      provider: "anthropic",
      triggerTokens: 170_000,
    });
    expect(buildProviderNativeCompactionOptions(config)).toEqual({
      anthropic: {
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

  it("detects applied Anthropic native compaction from provider metadata", () => {
    expect(
      extractProviderNativeCompactionUsage({
        anthropic: {
          contextManagement: {
            appliedEdits: [{ type: "compact_20260112" }],
          },
        },
      }),
    ).toEqual({
      applied: true,
      mode: "anthropic-context-management-compact",
      provider: "anthropic",
    });
  });
});
