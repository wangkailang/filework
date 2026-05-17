/**
 * GAIA dataset loader — reads `metadata.parquet` (current GAIA format
 * on HF) or `metadata.jsonl` (older releases) from a downloaded GAIA
 * split (e.g. `gaia-benchmark/GAIA/2023/validation/`) and normalises
 * the upstream record shape (which uses spaces + capitals in field
 * names) into the in-process `NormalizedQuestion` form.
 *
 * The dataset is NOT auto-downloaded — GAIA requires accepting a
 * license on HF, so the user runs `hf download gaia-benchmark/GAIA
 * --repo-type dataset --local-dir <dir>` once and points the harness
 * at the resulting `validation/` directory.
 *
 * Parquet path uses `hyparquet` (pure-JS, zero native deps, ~200KB
 * unpacked). Validation logic is shared with the JSONL path via the
 * exported `parseRecord` helper.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import type { GaiaLevel, GaiaRawQuestion, NormalizedQuestion } from "./types";

const VALID_LEVELS: ReadonlySet<number> = new Set([1, 2, 3]);

const PARQUET_NAME = "metadata.parquet";
const JSONL_NAME = "metadata.jsonl";

/**
 * Coerce a value that might be `bigint` (parquet INT64), `number`
 * (parquet INT32 / JSON), or an integer-shaped `string` (GAIA's
 * parquet stores Level as a string `"1"`/`"2"`/`"3"`) into a plain
 * `number`. Returns NaN for anything else so the caller can treat it
 * as invalid.
 */
const toNumber = (v: unknown): number => {
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string") {
    const trimmed = v.trim();
    if (/^-?\d+$/.test(trimmed)) return Number(trimmed);
  }
  return Number.NaN;
};

/**
 * Annotator Metadata may arrive as a struct (parquet's nested decoder)
 * or as a JSON string (some legacy exports). Best-effort extraction —
 * we only consume `Steps` and only for human-facing context.
 */
const extractAnnotatorSteps = (v: unknown): string | undefined => {
  if (v === null || v === undefined) return undefined;
  if (typeof v === "object") {
    const s = (v as { Steps?: unknown }).Steps;
    return typeof s === "string" ? s : undefined;
  }
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v) as { Steps?: unknown };
      return typeof parsed.Steps === "string" ? parsed.Steps : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
};

/**
 * Validate + normalise a single raw record (from either parquet or
 * JSONL). Returns `null` when required fields are missing or have the
 * wrong shape so the caller can keep going instead of crashing on one
 * bad row.
 *
 * Exported so unit tests can exercise the validation logic without
 * going through the I/O path.
 */
export const parseRecord = (raw: unknown): NormalizedQuestion | null => {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Partial<GaiaRawQuestion>;

  if (typeof r.task_id !== "string" || r.task_id.length === 0) return null;
  if (typeof r.Question !== "string") return null;
  if (typeof r["Final answer"] !== "string") return null;

  const level = toNumber(r.Level);
  if (!VALID_LEVELS.has(level)) return null;

  const fileName =
    typeof r.file_name === "string" && r.file_name.length > 0
      ? r.file_name
      : null;

  return {
    taskId: r.task_id,
    level: level as GaiaLevel,
    question: r.Question,
    groundTruth: r["Final answer"],
    fileName,
    annotatorSteps: extractAnnotatorSteps(r["Annotator Metadata"]),
  };
};

/**
 * Parse a single JSONL line. Thin wrapper over `parseRecord`; kept as
 * a named export because the existing test suite + downstream tooling
 * reference it.
 */
export const parseLine = (line: string): NormalizedQuestion | null => {
  if (line.trim().length === 0) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  return parseRecord(raw);
};

export interface LoadResult {
  questions: NormalizedQuestion[];
  /** Number of records that failed to parse — surfaced so the CLI can warn. */
  skipped: number;
}

/**
 * Read all rows from a parquet file. hyparquet returns rows as plain
 * objects keyed by column name; nested structs decode into nested
 * objects. The whole file is buffered into memory — GAIA splits are
 * tiny (~165 rows for validation, well under 1MB).
 *
 * Dynamic import: hyparquet ships as ESM-only with no CJS fallback in
 * its `exports` map, but this project still defaults to CJS resolution
 * (Electron's main process is CJS). The `await import(...)` keeps the
 * dataset module CJS-compatible while hyparquet loads correctly.
 */
const loadParquet = async (filePath: string): Promise<unknown[]> => {
  const { parquetReadObjects } = await import("hyparquet");
  const buf = await readFile(filePath);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return await parquetReadObjects({ file: ab });
};

/**
 * Load + normalise the questions in `<datasetDir>`. Prefers
 * `metadata.parquet` (current GAIA HF layout); falls back to
 * `metadata.jsonl` for older snapshots. Throws when neither is
 * present.
 */
export const loadGaiaDataset = async (
  datasetDir: string,
): Promise<LoadResult> => {
  const parquetPath = path.join(datasetDir, PARQUET_NAME);
  if (existsSync(parquetPath)) {
    const rows = await loadParquet(parquetPath);
    const questions: NormalizedQuestion[] = [];
    let skipped = 0;
    for (const row of rows) {
      const q = parseRecord(row);
      if (q) questions.push(q);
      else skipped++;
    }
    return { questions, skipped };
  }

  const jsonlPath = path.join(datasetDir, JSONL_NAME);
  const raw = await readFile(jsonlPath, "utf-8");
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
