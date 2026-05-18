import { describe, expect, it } from "vitest";
import { needsPlanning } from "../plan-generator";

describe("needsPlanning() heuristic", () => {
  describe("single-deliverable fast-exit", () => {
    it("does NOT plan a short '生成 X 报告' request that overlaps multiple task skills", () => {
      // Original screenshot case: hits report-generator ("统计报告")
      // AND data-processor ("统计", "json"), but the user wants ONE artifact.
      expect(
        needsPlanning(
          "帮我生成 Downloads 的统计报告，必须用 JSON 格式输出，不要 Markdown",
        ),
      ).toBe(false);
    });

    it("does NOT plan '导出 CSV 为 JSON'", () => {
      expect(needsPlanning("导出 CSV 为 JSON")).toBe(false);
    });

    it("does NOT plan an English 'create a report' request", () => {
      expect(needsPlanning("create a report of my downloads")).toBe(false);
    });

    it("does NOT plan '请生成一份月度统计' even with skill keyword overlap", () => {
      expect(needsPlanning("请生成一份月度统计报告，json 格式")).toBe(false);
    });
  });

  describe("multi-action connectors still trigger plan", () => {
    it("plans '生成 X 并且按月归档' (含「并且」)", () => {
      expect(needsPlanning("生成 Downloads 报告并且按月归档")).toBe(true);
    });

    it("plans '生成 X，然后归档' (含「然后」)", () => {
      expect(needsPlanning("生成 Downloads 报告，然后归档")).toBe(true);
    });

    it("plans English request with 'and then'", () => {
      expect(
        needsPlanning("generate a report and then archive the originals"),
      ).toBe(true);
    });

    it("plans '整理 Downloads 并且生成清单报告' (multi-skill + 多动作)", () => {
      expect(needsPlanning("整理 Downloads 并且生成清单报告")).toBe(true);
    });
  });

  describe("length > 300 wins over single-deliverable", () => {
    it("plans an overly long '生成 X' request despite single-verb start", () => {
      const longTail = "细节".repeat(200);
      const prompt = `生成一份详细的报告 ${longTail}`;
      expect(prompt.length).toBeGreaterThan(300);
      expect(needsPlanning(prompt)).toBe(true);
    });
  });

  describe("existing fast-exits still work (regression)", () => {
    it("does NOT plan '总结 report.md'", () => {
      expect(needsPlanning("总结 report.md 文件")).toBe(false);
    });

    it("does NOT plan 'summarize report.md'", () => {
      expect(needsPlanning("summarize report.md")).toBe(false);
    });

    it("does NOT plan a single-keyword short prompt", () => {
      // Only hits one task skill — falls through to default false.
      expect(needsPlanning("查找 downloads 里的 pdf")).toBe(false);
    });
  });
});
