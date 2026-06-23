import { describe, expect, it } from "vitest";
import { validateLlmConfigPayload } from "../llm-config-handlers";

describe("validateLlmConfigPayload — xiaomi provider", () => {
  it("accepts a complete xiaomi config (apiKey + baseUrl + model)", () => {
    const err = validateLlmConfigPayload({
      name: "My MiMo",
      provider: "xiaomi",
      apiKey: "sk-test",
      baseUrl: "https://example.xiaomi.com/v1",
      model: "mimo-v2.5-pro",
    });
    expect(err).toBeNull();
  });

  it("rejects xiaomi config missing apiKey", () => {
    const err = validateLlmConfigPayload({
      name: "My MiMo",
      provider: "xiaomi",
      baseUrl: "https://example.xiaomi.com/v1",
      model: "mimo-v2.5-pro",
    });
    expect(err).toMatch(/apiKey/);
  });

  it("rejects xiaomi config missing baseUrl", () => {
    const err = validateLlmConfigPayload({
      name: "My MiMo",
      provider: "xiaomi",
      apiKey: "sk-test",
      model: "mimo-v2.5-pro",
    });
    expect(err).toMatch(/baseUrl/);
  });

  it("rejects empty/whitespace apiKey", () => {
    const err = validateLlmConfigPayload({
      name: "My MiMo",
      provider: "xiaomi",
      apiKey: "   ",
      baseUrl: "https://example.xiaomi.com/v1",
      model: "mimo-v2.5-pro",
    });
    expect(err).toMatch(/apiKey/);
  });

  it("rejects unknown provider (regression guard)", () => {
    const err = validateLlmConfigPayload({
      name: "Bogus",
      provider: "bogus-provider" as unknown as "xiaomi",
      apiKey: "sk-test",
      baseUrl: "https://example.com",
      model: "foo",
    });
    expect(err).toMatch(/Invalid provider/);
  });

  it("does not validate the model id against the token-budget table", () => {
    // 未知的 model id 仍应通过校验 —— 运行时会回落到
    // DEFAULT_TOKEN_BUDGET。防止未来收紧校验后,新 MiMo SKU 一上线就被拦掉。
    const err = validateLlmConfigPayload({
      name: "MiMo Future",
      provider: "xiaomi",
      apiKey: "sk-test",
      baseUrl: "https://example.xiaomi.com/v1",
      model: "mimo-v3-experimental",
    });
    expect(err).toBeNull();
  });
});

describe("validateLlmConfigPayload — OpenAI Compatible provider", () => {
  it("accepts a complete custom OpenAI-compatible config", () => {
    const err = validateLlmConfigPayload({
      name: "OpenRouter",
      provider: "custom",
      apiKey: "sk-test",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "openai/gpt-4o-mini",
    });

    expect(err).toBeNull();
  });

  it("accepts custom OpenAI-compatible config without apiKey for local servers", () => {
    const err = validateLlmConfigPayload({
      name: "OpenRouter",
      provider: "custom",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "openai/gpt-4o-mini",
    });

    expect(err).toBeNull();
  });

  it("accepts a chat completions API path for custom OpenAI-compatible configs", () => {
    const err = validateLlmConfigPayload({
      name: "Gateway",
      provider: "custom",
      baseUrl: "https://gateway.example.com",
      apiPath: "/v1/chat/completions",
      model: "gpt-4o-mini",
    });

    expect(err).toBeNull();
  });

  it("rejects custom API paths that are not absolute paths", () => {
    const err = validateLlmConfigPayload({
      name: "Gateway",
      provider: "custom",
      baseUrl: "https://gateway.example.com",
      apiPath: "v1/chat/completions",
      model: "gpt-4o-mini",
    });

    expect(err).toMatch(/apiPath/);
  });

  it("rejects custom API paths outside the chat completions endpoint contract", () => {
    const err = validateLlmConfigPayload({
      name: "Gateway",
      provider: "custom",
      baseUrl: "https://gateway.example.com",
      apiPath: "/v1/responses",
      model: "gpt-4o-mini",
    });

    expect(err).toMatch(/apiPath/);
  });

  it("accepts advanced generation options inside safe ranges", () => {
    const err = validateLlmConfigPayload({
      name: "OpenRouter",
      provider: "custom",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "openai/gpt-4o-mini",
      temperature: 0.2,
      topP: 0.9,
      maxOutputTokens: 4096,
      reasoningEffort: "medium",
    });

    expect(err).toBeNull();
  });

  it("rejects invalid advanced generation option ranges", () => {
    expect(
      validateLlmConfigPayload({
        name: "OpenRouter",
        provider: "custom",
        baseUrl: "https://openrouter.ai/api/v1",
        model: "openai/gpt-4o-mini",
        temperature: 2.5,
      }),
    ).toMatch(/temperature/);
    expect(
      validateLlmConfigPayload({
        name: "OpenRouter",
        provider: "custom",
        baseUrl: "https://openrouter.ai/api/v1",
        model: "openai/gpt-4o-mini",
        topP: -0.1,
      }),
    ).toMatch(/topP/);
    expect(
      validateLlmConfigPayload({
        name: "OpenRouter",
        provider: "custom",
        baseUrl: "https://openrouter.ai/api/v1",
        model: "openai/gpt-4o-mini",
        maxOutputTokens: 0,
      }),
    ).toMatch(/maxOutputTokens/);
    expect(
      validateLlmConfigPayload({
        name: "OpenRouter",
        provider: "custom",
        baseUrl: "https://openrouter.ai/api/v1",
        model: "openai/gpt-4o-mini",
        reasoningEffort: "extreme" as never,
      }),
    ).toMatch(/reasoningEffort/);
  });
});

describe("validateLlmConfigPayload — GitHub Copilot provider", () => {
  it("accepts GitHub Copilot configs without a manually entered API key", () => {
    const err = validateLlmConfigPayload({
      name: "Copilot",
      provider: "github-copilot",
      baseUrl: "https://api.githubcopilot.com",
      apiPath: "/chat/completions",
      model: "gpt-5.5",
    });

    expect(err).toBeNull();
  });
});
