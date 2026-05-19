import { describe, expect, it } from "vitest";
import { createModelWithAdapter, resolveAdapterName } from "../index";

describe("resolveAdapterName", () => {
  it("returns the provider unchanged for plain OpenAI configs", () => {
    expect(resolveAdapterName("openai", "https://api.openai.com/v1")).toBe(
      "openai",
    );
  });

  it("returns the provider unchanged when no baseUrl is set", () => {
    expect(resolveAdapterName("openai")).toBe("openai");
    expect(resolveAdapterName("custom", null)).toBe("custom");
  });

  it("routes custom configs pointing at Xiaomi MiMo to the xiaomi adapter", () => {
    // Real Xiaomi endpoint seen in production logs.
    expect(
      resolveAdapterName("custom", "https://token-plan-sgp.xiaomimimo.com/v1"),
    ).toBe("xiaomi");
  });

  it("routes plain openai-typed configs at Xiaomi to xiaomi too", () => {
    // Older configs created before the xiaomi provider existed often
    // carry `provider: 'openai'` with the Xiaomi baseUrl.
    expect(resolveAdapterName("openai", "https://api.xiaomimimo.com/v1")).toBe(
      "xiaomi",
    );
  });

  it("leaves already-correct xiaomi configs alone", () => {
    expect(
      resolveAdapterName("xiaomi", "https://token-plan-sgp.xiaomimimo.com/v1"),
    ).toBe("xiaomi");
  });

  it("does not match xiaomi look-alike hosts", () => {
    // Anti-spoof: must be the actual xiaomimimo.com domain.
    expect(
      resolveAdapterName(
        "custom",
        "https://xiaomimimo.com.attacker.example/v1",
      ),
    ).toBe("custom");
    expect(resolveAdapterName("custom", "https://xiaomi.com/v1")).toBe(
      "custom",
    );
  });

  it("handles malformed baseUrls gracefully", () => {
    expect(resolveAdapterName("custom", "not-a-url")).toBe("custom");
  });
});

describe("createModelWithAdapter (Xiaomi auto-routing)", () => {
  it("hands a custom-provider Xiaomi config to the xiaomi adapter", () => {
    const { adapter } = createModelWithAdapter({
      provider: "custom",
      apiKey: "test-key",
      baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1",
      model: "mimo-v2.5-pro",
    });
    // The dedicated XiaomiAdapter wraps DeepSeek with a fetch
    // interceptor that re-stamps reasoning_content on every prior
    // assistant turn — fixes Xiaomi's "must be passed back" 400 on the
    // 2nd+ turn that the raw deepseek adapter would otherwise drop.
    expect(adapter.name).toBe("xiaomi");
  });
});
