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
    // 生产日志中出现的真实小米端点。
    expect(
      resolveAdapterName("custom", "https://token-plan-sgp.xiaomimimo.com/v1"),
    ).toBe("xiaomi");
  });

  it("routes plain openai-typed configs at Xiaomi to xiaomi too", () => {
    // 在 xiaomi provider 出现之前创建的旧配置,通常
    // 带着 Xiaomi 的 baseUrl 却使用 `provider: 'openai'`。
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
    // 防伪造:必须是真正的 xiaomimimo.com 域名。
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
    // 专用的 XiaomiAdapter 通过 fetch 拦截器包装 DeepSeek,
    // 在之前每一个 assistant 回合上重新写入 reasoning_content ——
    // 修复了 Xiaomi 在第 2 个及以后回合出现的 "must be passed back" 400 错误,
    // 该字段原本会被裸 deepseek adapter 丢弃。
    expect(adapter.name).toBe("xiaomi");
  });
});
