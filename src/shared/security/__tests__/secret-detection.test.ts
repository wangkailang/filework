import { describe, expect, it } from "vitest";

import {
  containsSecret,
  redactDeep,
  redactSecrets,
} from "../secret-detection";

describe("secret-detection", () => {
  describe("containsSecret", () => {
    it("命中已知厂商前缀与赋值式", () => {
      expect(containsSecret("token is sk-abcdefghijklmnop1234")).toBe(true);
      expect(containsSecret("use ghp_0123456789abcdefghijABCDEFGHIJ12")).toBe(true);
      expect(containsSecret("password=hunter2hunter")).toBe(true);
      expect(containsSecret("-----BEGIN OPENSSH PRIVATE KEY-----")).toBe(true);
    });

    it("命中自然语言里的厂商 key(关键词 + 高熵 token)", () => {
      expect(
        containsSecret(
          "xiaomi llm key tp-sxnbvy8nfbqn8ocd7o974kbohq6s1hh3nmak6req8qeenm41 记一下",
        ),
      ).toBe(true);
      expect(containsSecret("我的密钥是 ab12cd34ef56gh78ij90kl12mn34")).toBe(true);
    });

    it("命中全角冒号紧贴、token 前无空格的中文写法(回归)", () => {
      expect(
        containsSecret(
          "小米LLM API密钥：tp-sxnbvy8nfbqn8ocd7o974kbohq6s1hh3nmak6req8qeenm41",
        ),
      ).toBe(true);
    });

    it("无关键词时,足够长的独立高熵 token 也命中", () => {
      expect(
        containsSecret("记住 tp-sxnbvy8nfbqn8ocd7o974kbohq6s1hh3nmak6"),
      ).toBe(true);
    });

    it("不误伤普通事实/路径/hash/uuid", () => {
      expect(containsSecret("uses pnpm and vitest")).toBe(false);
      expect(containsSecret("回复语言使用中文")).toBe(false);
      expect(containsSecret("项目根目录是 /Users/kailang/develop/2026/filework")).toBe(false);
      expect(containsSecret("build at commit a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0")).toBe(false);
      expect(containsSecret("session 550e8400-e29b-41d4-a716-446655440000")).toBe(false);
      expect(containsSecret("见 https://github.com/foo/bar 文档")).toBe(false);
    });
  });

  describe("redactSecrets", () => {
    it("掩码命中的 token,格式为首2+••••+末2,并返回 count", () => {
      const r = redactSecrets(
        "小米LLM API密钥：tp-sxnbvy8nfbqn8ocd7o974kbohq6s1hh3nmak6req8qeenm41",
      );
      expect(r.count).toBe(1);
      expect(r.text).toContain("tp••••41");
      expect(r.text).not.toContain("sxnbvy8");
    });

    it("ASCII 冒号 + 空格写法同样掩码", () => {
      const r = redactSecrets(
        "api key: tp-sxnbvy8nfbqn8ocd7o974kbohq6s1hh3nmak6req8qeenm41",
      );
      expect(r.count).toBe(1);
      expect(r.text).not.toContain("sxnbvy8");
    });

    it("无密钥文本原样返回,count=0", () => {
      const r = redactSecrets("项目使用 React 和 Electron");
      expect(r).toEqual({ text: "项目使用 React 和 Electron", count: 0 });
    });

    it("空串安全返回", () => {
      expect(redactSecrets("")).toEqual({ text: "", count: 0 });
    });

    it("厂商前缀与赋值式同时命中同一 token 时只计一次(回归)", () => {
      const r = redactSecrets("token = sk-abcdefghijklmnop1234");
      expect(r.count).toBe(1);
      expect(r.text).not.toContain("sk-abcdefghijklmnop1234");
    });
  });

  describe("redactDeep", () => {
    it("递归掩码对象/数组里的字符串叶子并累计 count", () => {
      const r = redactDeep({
        a: "api key: tp-sxnbvy8nfbqn8ocd7o974kbohq6s1hh3nmak6req8qeenm41",
        b: ["clean", "the secret token is sk-abcdefghijklmnop1234"],
        c: 42,
      });
      expect(r.count).toBe(2);
      const v = r.value as { a: string; b: string[]; c: number };
      expect(v.a).not.toContain("sxnbvy8");
      expect(v.b[0]).toBe("clean");
      expect(v.c).toBe(42);
    });

    it("非字符串原样返回 count=0", () => {
      expect(redactDeep(123)).toEqual({ value: 123, count: 0 });
      expect(redactDeep(null)).toEqual({ value: null, count: 0 });
    });

    it("空字符串叶子安全处理", () => {
      const r = redactDeep({ x: "" });
      expect(r.count).toBe(0);
      expect((r.value as { x: string }).x).toBe("");
    });
  });
});
