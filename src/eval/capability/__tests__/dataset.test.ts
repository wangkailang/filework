/**
 * Smoke tests for the capability synthetic dataset.
 *
 * These tests verify the dataset *itself* — that every task entry
 * parses as a valid GAIA record, every declared attachment exists on
 * disk, and the expected answers are still satisfiable by the fixture
 * files. They do NOT execute the agent — that requires an LLM and is
 * driven by `pnpm gaia-eval --dataset src/eval/capability/dataset`.
 *
 * The goal is to catch fixture drift: if someone deletes one of the
 * txt/csv/json fixtures or changes a fixture's contents in a way that
 * breaks the declared answer, this test will surface it.
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

// ─── Verify each declared answer is satisfiable by the fixture ───────

/**
 * Per-task verifier — runs the same deterministic computation the
 * agent would, without any LLM, to confirm the declared `Final answer`
 * matches what the fixture content implies. Catches fixture/answer
 * drift on every test run.
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
