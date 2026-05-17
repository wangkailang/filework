/**
 * GAIA dataset loader — reads the `metadata.jsonl` from a downloaded
 * GAIA split (e.g. `gaia-benchmark/GAIA/2023/validation/`) and
 * normalises the upstream record shape (which uses spaces + capitals
 * in field names) into the in-process `NormalizedQuestion` form.
 *
 * The dataset is NOT auto-downloaded — GAIA requires accepting a
 * license on HF, so the user runs `huggingface-cli download
 * gaia-benchmark/GAIA --repo-type dataset --local-dir <dir>` once and
 * points the harness at the resulting `validation/` directory.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

import type { GaiaLevel, GaiaRawQuestion, NormalizedQuestion } from "./types";

const VALID_LEVELS: ReadonlySet<number> = new Set([1, 2, 3]);

/**
 * Parse a single JSONL line into a normalised question. Returns `null`
 * for unparseable / invalid records so the caller can keep going
 * instead of crashing on a single bad line.
 */
export const parseLine = (line: string): NormalizedQuestion | null => {
  if (line.trim().length === 0) return null;
  let raw: GaiaRawQuestion;
  try {
    raw = JSON.parse(line) as GaiaRawQuestion;
  } catch {
    return null;
  }
  if (typeof raw.task_id !== "string" || raw.task_id.length === 0) return null;
  if (typeof raw.Question !== "string") return null;
  if (typeof raw["Final answer"] !== "string") return null;
  if (!VALID_LEVELS.has(raw.Level)) return null;

  const fileName =
    typeof raw.file_name === "string" && raw.file_name.length > 0
      ? raw.file_name
      : null;

  return {
    taskId: raw.task_id,
    level: raw.Level as GaiaLevel,
    question: raw.Question,
    groundTruth: raw["Final answer"],
    fileName,
    annotatorSteps: raw["Annotator Metadata"]?.Steps,
  };
};

export interface LoadResult {
  questions: NormalizedQuestion[];
  /** Number of lines that failed to parse — surfaced so the CLI can warn. */
  skipped: number;
}

/**
 * Load and parse `<datasetDir>/metadata.jsonl`. Throws when the file
 * doesn't exist; logs (via `skipped`) when individual records are
 * malformed.
 */
export const loadGaiaDataset = async (
  datasetDir: string,
): Promise<LoadResult> => {
  const metaPath = path.join(datasetDir, "metadata.jsonl");
  const raw = await readFile(metaPath, "utf-8");
  const lines = raw.split(/\r?\n/);
  const questions: NormalizedQuestion[] = [];
  let skipped = 0;
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    const q = parseLine(line);
    if (q) questions.push(q);
    else skipped++;
  }
  return { questions, skipped };
};

export interface FilterOptions {
  level?: GaiaLevel | "all";
  limit?: number | null;
  /** When true, sample randomly from the filtered set instead of taking head-N. */
  random?: boolean;
  /** Seed for the random sampler. Useful for reproducible smokes. */
  seed?: number;
}

/**
 * Deterministic mulberry32 — small, dependency-free PRNG good enough
 * for "pick 5 random questions for a smoke."
 */
const mulberry32 = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
};

/**
 * Apply level + limit + (optionally) shuffle filters. Returns a new
 * array; the input is never mutated.
 */
export const filterQuestions = (
  questions: readonly NormalizedQuestion[],
  opts: FilterOptions = {},
): NormalizedQuestion[] => {
  let out: NormalizedQuestion[] = [...questions];
  if (opts.level && opts.level !== "all") {
    out = out.filter((q) => q.level === opts.level);
  }
  if (opts.random) {
    const rand = mulberry32(opts.seed ?? 1);
    // Fisher–Yates so the sample is uniform even when `limit` is small.
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
  }
  if (opts.limit && opts.limit > 0) {
    out = out.slice(0, opts.limit);
  }
  return out;
};
