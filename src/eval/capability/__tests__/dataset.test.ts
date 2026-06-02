/**
 * capability 合成数据集的冒烟测试。
 *
 * 这些测试验证的是数据集*本身* —— 每个任务条目都能解析为合法的
 * GAIA 记录、每个声明的附件都存在于磁盘上,并且期望答案仍能由
 * fixture 文件满足。它们*不*执行 agent —— 那需要 LLM,
 * 由 `pnpm gaia-eval --dataset src/eval/capability/dataset` 驱动。
 *
 * 目标是捕获 fixture 漂移:如果有人删除了某个 txt/csv/json
 * fixture,或以破坏声明答案的方式修改了 fixture 内容,
 * 该测试会将其暴露出来。
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { filterQuestions, loadGaiaDataset } from "../../gaia/dataset";

const DATASET_DIR = path.join(__dirname, "..", "dataset");

const loadAndExpectClean = async () => {
  const { questions, skipped } = await loadGaiaDataset(DATASET_DIR);
  expect(skipped, "no records should fail to parse").toBe(0);
  return questions;
};

describe("capability dataset", () => {
  it("loads as a valid GAIA-shape dataset", async () => {
    const questions = await loadAndExpectClean();
    expect(questions.length).toBeGreaterThanOrEqual(10);
    for (const q of questions) {
      expect(q.taskId).toMatch(/^cap-\d{3}-/);
      expect(q.level).toBe(1);
      expect(q.question.length).toBeGreaterThan(0);
      expect(q.groundTruth.length).toBeGreaterThan(0);
    }
  });

  it("has unique task ids", async () => {
    const questions = await loadAndExpectClean();
    const ids = questions.map((q) => q.taskId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every declared attachment exists on disk", async () => {
    const questions = await loadAndExpectClean();
    for (const q of questions) {
      if (!q.fileName) continue;
      const p = path.join(DATASET_DIR, q.fileName);
      try {
        await readFile(p);
      } catch (err) {
        throw new Error(
          `task ${q.taskId} declares attachment ${q.fileName} but ${p} is missing: ${(err as Error).message}`,
        );
      }
    }
  });

  it("filterQuestions composes with capability dataset", async () => {
    const all = await loadAndExpectClean();
    const limit3 = filterQuestions(all, { level: 1, limit: 3 });
    expect(limit3).toHaveLength(3);
    expect(limit3[0].taskId).toBe(all[0].taskId);
  });
});

// ─── 验证每个声明的答案都能由 fixture 满足 ───────

/**
 * 单任务校验器 —— 在不依赖任何 LLM 的情况下,执行与 agent 相同的
 * 确定性计算,确认声明的 `Final answer` 与 fixture 内容所隐含的
 * 结果一致。每次测试运行都能捕获 fixture/答案漂移。
 */
const verifyAnswer = async (
  taskId: string,
  fileName: string | null,
  groundTruth: string,
): Promise<void> => {
  if (!fileName) {
    expect(groundTruth.length).toBeGreaterThan(0);
    return;
  }
  const content = await readFile(path.join(DATASET_DIR, fileName), "utf-8");

  switch (taskId) {
    case "cap-001-md-h2": {
      const h2s = content
        .split("\n")
        .filter((l) => l.startsWith("## "))
        .map((l) => l.replace(/^##\s+/, "").trim());
      expect(h2s[1]).toBe(groundTruth);
      break;
    }
    case "cap-002-csv-rows": {
      const dataRows =
        content.split("\n").filter((l) => l.trim().length > 0).length - 1;
      expect(String(dataRows)).toBe(groundTruth);
      break;
    }
    case "cap-003-numbers-sum": {
      const sum = content
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map((l) => Number(l.trim()))
        .reduce((a, b) => a + b, 0);
      expect(String(sum)).toBe(groundTruth);
      break;
    }
    case "cap-004-log-error-count": {
      const count = content
        .split("\n")
        .filter((l) => l.startsWith("ERROR")).length;
      expect(String(count)).toBe(groundTruth);
      break;
    }
    case "cap-005-json-array-length": {
      const arr = JSON.parse(content) as unknown[];
      expect(String(arr.length)).toBe(groundTruth);
      break;
    }
    case "cap-008-yaml-version": {
      const m = content.match(/^version:\s*(\S+)/m);
      expect(m?.[1]).toBe(groundTruth);
      break;
    }
    case "cap-009-tsv-max": {
      const rows = content
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .slice(1)
        .map((l) => l.split("\t"));
      const max = Math.max(...rows.map((cols) => Number(cols[1])));
      expect(String(max)).toBe(groundTruth);
      break;
    }
    case "cap-010-extension-count": {
      const count = content
        .split("\n")
        .filter((l) => l.trim().endsWith(".txt")).length;
      expect(String(count)).toBe(groundTruth);
      break;
    }
    default:
      throw new Error(`no verifier for task ${taskId}`);
  }
};

describe("capability dataset — answer verifiers", () => {
  it("every declared answer matches the fixture content", async () => {
    const questions = await loadAndExpectClean();
    for (const q of questions) {
      await verifyAnswer(q.taskId, q.fileName, q.groundTruth);
    }
  });
});
