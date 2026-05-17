import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { filterQuestions, loadGaiaDataset, parseLine } from "../dataset";

// ─── parseLine ───────────────────────────────────────────────────────

describe("parseLine", () => {
  it("normalises a well-formed record", () => {
    const line = JSON.stringify({
      task_id: "abc-123",
      Question: "What is 2+2?",
      Level: 1,
      "Final answer": "4",
      file_name: "",
      "Annotator Metadata": { Steps: "Add 2 and 2." },
    });
    expect(parseLine(line)).toEqual({
      taskId: "abc-123",
      level: 1,
      question: "What is 2+2?",
      groundTruth: "4",
      fileName: null,
      annotatorSteps: "Add 2 and 2.",
    });
  });

  it("translates a non-empty file_name to the attachment path", () => {
    const q = parseLine(
      JSON.stringify({
        task_id: "x",
        Question: "q",
        Level: 2,
        "Final answer": "y",
        file_name: "audio.mp3",
      }),
    );
    expect(q?.fileName).toBe("audio.mp3");
  });

  it("returns null for malformed JSON", () => {
    expect(parseLine("not json")).toBeNull();
    expect(parseLine("{not closed")).toBeNull();
  });

  it("returns null when required fields are missing or wrong type", () => {
    expect(parseLine(JSON.stringify({}))).toBeNull();
    expect(
      parseLine(
        JSON.stringify({
          task_id: "x",
          Question: "q",
          Level: 1,
          "Final answer": 42, // wrong type
          file_name: "",
        }),
      ),
    ).toBeNull();
  });

  it("rejects invalid Level values", () => {
    expect(
      parseLine(
        JSON.stringify({
          task_id: "x",
          Question: "q",
          Level: 4,
          "Final answer": "y",
          file_name: "",
        }),
      ),
    ).toBeNull();
    expect(
      parseLine(
        JSON.stringify({
          task_id: "x",
          Question: "q",
          Level: 0,
          "Final answer": "y",
          file_name: "",
        }),
      ),
    ).toBeNull();
  });

  it("rejects records with an empty task_id", () => {
    expect(
      parseLine(
        JSON.stringify({
          task_id: "",
          Question: "q",
          Level: 1,
          "Final answer": "y",
          file_name: "",
        }),
      ),
    ).toBeNull();
  });

  it("returns null for blank lines", () => {
    expect(parseLine("")).toBeNull();
    expect(parseLine("   ")).toBeNull();
  });
});

// ─── loadGaiaDataset ─────────────────────────────────────────────────

describe("loadGaiaDataset", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "gaia-test-"));
  });

  const write = async (content: string) =>
    writeFile(path.join(dir, "metadata.jsonl"), content, "utf-8");

  it("loads every parseable line and counts skipped ones", async () => {
    const ok1 = JSON.stringify({
      task_id: "a",
      Question: "q1",
      Level: 1,
      "Final answer": "r1",
      file_name: "",
    });
    const ok2 = JSON.stringify({
      task_id: "b",
      Question: "q2",
      Level: 2,
      "Final answer": "r2",
      file_name: "x.pdf",
    });
    const bad = "not json";
    await write(`${ok1}\n${bad}\n${ok2}\n\n`);

    const result = await loadGaiaDataset(dir);
    expect(result.questions).toHaveLength(2);
    expect(result.questions.map((q) => q.taskId)).toEqual(["a", "b"]);
    expect(result.skipped).toBe(1);
  });

  it("returns zero questions when the file exists but is empty", async () => {
    await write("");
    const result = await loadGaiaDataset(dir);
    expect(result.questions).toHaveLength(0);
    expect(result.skipped).toBe(0);
  });

  it("throws when metadata.jsonl is missing", async () => {
    await expect(loadGaiaDataset(dir)).rejects.toThrow(/ENOENT|no such file/);
  });
});

// ─── filterQuestions ─────────────────────────────────────────────────

const make = (level: 1 | 2 | 3, id: string) => ({
  taskId: id,
  level,
  question: "?",
  groundTruth: "?",
  fileName: null,
});

const SAMPLE = [
  make(1, "a"),
  make(2, "b"),
  make(1, "c"),
  make(3, "d"),
  make(2, "e"),
  make(1, "f"),
];

describe("filterQuestions", () => {
  it("returns a fresh array (does not mutate the input)", () => {
    const before = [...SAMPLE];
    const out = filterQuestions(SAMPLE, { level: 1 });
    expect(SAMPLE).toEqual(before);
    expect(out).not.toBe(SAMPLE);
  });

  it("filters by level", () => {
    const out = filterQuestions(SAMPLE, { level: 1 });
    expect(out.map((q) => q.taskId)).toEqual(["a", "c", "f"]);
  });

  it("level='all' keeps every question", () => {
    expect(filterQuestions(SAMPLE, { level: "all" }).length).toBe(
      SAMPLE.length,
    );
  });

  it("limit takes head-N when random is false (default)", () => {
    const out = filterQuestions(SAMPLE, { level: 1, limit: 2 });
    expect(out.map((q) => q.taskId)).toEqual(["a", "c"]);
  });

  it("random shuffling is deterministic with the same seed", () => {
    const a = filterQuestions(SAMPLE, { random: true, seed: 7, limit: 3 });
    const b = filterQuestions(SAMPLE, { random: true, seed: 7, limit: 3 });
    expect(a.map((q) => q.taskId)).toEqual(b.map((q) => q.taskId));
  });

  it("random shuffling with different seeds yields different orders", () => {
    const a = filterQuestions(SAMPLE, { random: true, seed: 1 });
    const b = filterQuestions(SAMPLE, { random: true, seed: 2 });
    expect(a.map((q) => q.taskId)).not.toEqual(b.map((q) => q.taskId));
  });

  it("limit=null or limit=0 is treated as no limit", () => {
    expect(filterQuestions(SAMPLE, { limit: null }).length).toBe(SAMPLE.length);
    expect(filterQuestions(SAMPLE, { limit: 0 }).length).toBe(SAMPLE.length);
  });
});
