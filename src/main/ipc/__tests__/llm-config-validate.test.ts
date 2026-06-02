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
