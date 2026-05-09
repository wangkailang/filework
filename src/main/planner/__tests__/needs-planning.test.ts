import { describe, expect, it } from "vitest";
import { needsPlanning } from "../index";

describe("needsPlanning", () => {
  describe("knowledge / analytical questions (no file references)", () => {
    const cases = [
      "分析Hermes Agent 与 Openclaw 的区别，以及各自的优劣势",
      "对比 React 和 Vue 的差异",
      "解释一下什么是事件循环",
      "介绍 RAG 的工作原理",
      "compare GPT-4 vs Claude",
      "explain how attention works in transformers",
      "what's the difference between TCP and UDP",
    ];
    for (const prompt of cases) {
      it(`returns false for: ${prompt}`, () => {
        expect(needsPlanning(prompt)).toBe(false);
      });
    }
  });

  describe("knowledge starters that DO reference files (still plan)", () => {
    it("plans when '分析' is followed by a file/folder reference", () => {
      expect(
        needsPlanning("分析 reports/ 下的销售数据，以及生成同比图表"),
      ).toBe(true);
    });
  });

  describe("genuine multi-step tasks", () => {
    it("plans when prompt has multi-action connector and file work", () => {
      expect(
        needsPlanning("整理 docs 文件夹里的 markdown，然后生成索引文件"),
      ).toBe(true);
    });
  });

  describe("simple single-action prompts still skip planning", () => {
    it("does not plan a simple summarize-file request", () => {
      expect(needsPlanning("总结 report.pdf 的内容")).toBe(false);
    });
  });
});
