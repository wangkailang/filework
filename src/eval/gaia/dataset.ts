/**
 * GAIA 数据集加载器——从已下载的 GAIA 切分
 *(例如 `gaia-benchmark/GAIA/2023/validation/`)中读取
 * `metadata.parquet`(HF 上当前的 GAIA 格式)或 `metadata.jsonl`
 *(较早的发布版本),并将上游的记录结构(字段名使用空格 + 大写)
 * 归一化为进程内的 `NormalizedQuestion` 形式。
 *
 * 数据集不会自动下载——GAIA 要求在 HF 上接受
 * 许可协议,因此用户需先运行一次 `hf download gaia-benchmark/GAIA
 * --repo-type dataset --local-dir <dir>`,再将本工具指向
 * 生成的 `validation/` 目录。
 *
 * Parquet 路径使用 `hyparquet`(纯 JS、零原生依赖、解包后约 200KB)。
 * 校验逻辑通过导出的 `parseRecord` 辅助函数与 JSONL 路径共用。
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import type { GaiaLevel, GaiaRawQuestion, NormalizedQuestion } from "./types";

const VALID_LEVELS: ReadonlySet<number> = new Set([1, 2, 3]);

const PARQUET_NAME = "metadata.parquet";
const JSONL_NAME = "metadata.jsonl";

/**
 * 将可能是 `bigint`(parquet INT64)、`number`
 *(parquet INT32 / JSON)或整数形态的 `string`(GAIA 的
 * parquet 将 Level 存为字符串 `"1"`/`"2"`/`"3"`)的值强制转换为普通
 * `number`。对于其他任何情况返回 NaN,以便调用方将其
 * 视为无效。
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
 * Annotator Metadata 可能以结构体(parquet 的嵌套解码器)
 * 或 JSON 字符串(某些旧版导出)的形式出现。尽力提取——
 * 我们只消费 `Steps`,且仅用于面向人类的上下文。
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
 * 校验并归一化单条原始记录(来自 parquet 或
 * JSONL)。当必需字段缺失或结构不正确时返回 `null`,
 * 以便调用方继续处理,而不会因为一条
 * 坏行而崩溃。
 *
 * 导出此函数,以便单元测试可以在不经过 I/O 路径的情况下
 * 验证校验逻辑。
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
 * 解析单行 JSONL。对 `parseRecord` 的轻量封装;保留为
 * 具名导出,因为现有测试套件 + 下游工具
 * 引用了它。
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
  /** 解析失败的记录数——暴露出来以便 CLI 给出警告。 */
  skipped: number;
}

/**
 * 读取 parquet 文件中的所有行。hyparquet 将行作为以列名
 * 为键的普通对象返回;嵌套结构体解码为嵌套
 * 对象。整个文件会缓冲到内存——GAIA 切分
 * 很小(validation 约 165 行,远小于 1MB)。
 *
 * 动态导入:hyparquet 仅以 ESM 形式发布,其 `exports`
 * 映射中没有 CJS 回退,但本项目仍默认使用 CJS 解析
 *(Electron 主进程是 CJS)。`await import(...)` 让
 * dataset 模块保持 CJS 兼容,同时 hyparquet 能正确加载。
 */
const loadParquet = async (filePath: string): Promise<unknown[]> => {
  const { parquetReadObjects } = await import("hyparquet");
  const buf = await readFile(filePath);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return await parquetReadObjects({ file: ab });
};

/**
 * 加载并归一化 `<datasetDir>` 中的问题。优先使用
 * `metadata.parquet`(当前 GAIA HF 布局);对于较旧的快照
 * 回退到 `metadata.jsonl`。两者都不存在时
 * 抛出异常。
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
  /** 为 true 时,从过滤后的集合中随机采样,而非取前 N 个。 */
  random?: boolean;
  /** 随机采样器的种子。便于可复现的 smoke 运行。 */
  seed?: number;
}

/**
 * 确定性的 mulberry32——小巧、无依赖的伪随机数生成器,
 * 足以应对"为 smoke 随机挑选 5 个问题"的场景。
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
 * 应用 level + limit +(可选的)打乱过滤。返回一个新
 * 数组;输入永远不会被修改。
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
    // Fisher–Yates 洗牌,即使 `limit` 很小,采样也保持均匀。
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
