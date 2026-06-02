#!/usr/bin/env node
/**
 * `pnpm gaia-eval` 入口点。
 *
 * 纯 Node CLI——运行 `tsx src/eval/gaia/cli.ts`。参数解析
 * 使用 `util.parseArgs`(自 Node 18 起稳定),因此不引入 CLI
 * 库。
 *
 * 退出码:
 *   0 — 已完成(包括全部失败的运行);已写入摘要。
 *   1 — 配置错误(缺少必需参数、数据集路径错误等)。
 *   2 — 运行过程中的运行时错误(在尝试写入摘要后重新抛出)。
 */

import path from "node:path";
import { parseArgs } from "node:util";

import { runGaia } from "./runner";
import type { GaiaLevel } from "./types";

interface ParsedFlags {
  dataset: string;
  output: string;
  level: GaiaLevel | "all";
  limit: number | null;
  provider: string;
  apiKey: string;
  model: string;
  baseUrl?: string;
  /**
   * `number` → 传给 streamText / verifier;`null` → 省略该
   * 参数(OpenAI 推理模型)。默认值为 `0`(确定性)。
   */
  temperature: number | null;
  smoke: boolean;
  help: boolean;
}

const HELP = `gaia-eval — run the GAIA benchmark against the local filework agent.

Required flags:
  --dataset <dir>         GAIA validation directory (contains metadata.jsonl + attachments)
  --provider <name>       LLM provider: anthropic / openai / deepseek / minimax / xiaomi / custom
                          (xiaomi requires --base-url, e.g. https://api.xiaomimimo.com/v1)
  --api-key <key>         API key for the provider  (or env GAIA_EVAL_API_KEY)
  --model <id>            Model identifier, e.g. claude-sonnet-4-6, gpt-4o-2024-08-06

Optional:
  --output <dir>          Run artifacts directory  (default: ~/gaia-runs/<timestamp>)
  --level 1|2|3|all       Difficulty filter        (default: 1)
  --limit <N>             First N questions only   (default: all)
  --smoke                 Equivalent to --level 1 --limit 5
  --base-url <url>        Override provider endpoint (OpenAI-compatible providers and xiaomi)
  --temperature <n>       Sampling temperature      (default: 0 for deterministic runs)
                          Pass 'none' to omit the parameter — required for
                          OpenAI reasoning models (o1/o3/o5/gpt-5 reasoning)
                          which reject any temperature setting.

Environment:
  GAIA_EVAL_API_KEY       Used when --api-key is omitted
  TAVILY_API_KEY          Enables webSearch tool
  FIRECRAWL_API_KEY       Enables webScrape tool

Example:
  pnpm gaia-eval \\
    --dataset ~/datasets/gaia/2023/validation \\
    --provider anthropic \\
    --model claude-sonnet-4-6 \\
    --level 1 --limit 5

  pnpm gaia-eval \\
    --dataset ~/datasets/gaia/2023/validation \\
    --provider xiaomi \\
    --base-url https://api.xiaomimimo.com/v1 \\
    --model mimo-v2.5-pro \\
    --level 1 --limit 5
`;

const parseFlags = (argv: string[]): ParsedFlags | string => {
  const options = {
    dataset: { type: "string" as const },
    output: { type: "string" as const },
    level: { type: "string" as const, default: "1" },
    limit: { type: "string" as const },
    provider: { type: "string" as const },
    "api-key": { type: "string" as const },
    model: { type: "string" as const },
    "base-url": { type: "string" as const },
    temperature: { type: "string" as const, default: "0" },
    smoke: { type: "boolean" as const, default: false },
    help: { type: "boolean" as const, default: false, short: "h" },
  };
  let parsed: ReturnType<typeof parseArgs<{ options: typeof options }>>;
  try {
    parsed = parseArgs({ args: argv, options, allowPositionals: false });
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  const v = parsed.values;
  if (v.help) return "__help__";

  const smoke = Boolean(v.smoke);
  const levelArg = String(v.level ?? "1");
  let level: GaiaLevel | "all";
  if (levelArg === "all") level = "all";
  else if (levelArg === "1" || levelArg === "2" || levelArg === "3") {
    level = Number(levelArg) as GaiaLevel;
  } else {
    return `--level must be 1, 2, 3, or all (got "${levelArg}")`;
  }

  let limit: number | null = null;
  if (smoke) limit = 5;
  if (v.limit !== undefined) {
    const n = Number(v.limit);
    if (!Number.isInteger(n) || n <= 0) {
      return `--limit must be a positive integer (got "${String(v.limit)}")`;
    }
    limit = n;
  }

  if (!v.dataset) return "--dataset is required (see --help)";
  if (!v.provider) return "--provider is required (see --help)";
  if (!v.model) return "--model is required (see --help)";

  const apiKey =
    (v["api-key"] as string | undefined) ?? process.env.GAIA_EVAL_API_KEY;
  if (!apiKey) return "--api-key (or env GAIA_EVAL_API_KEY) is required";

  // 温度:数字字符串 → number;"none" / "default" / "off" → null
  //(省略该参数——OpenAI 推理模型需要如此)。
  const tempArg = String(v.temperature ?? "0")
    .trim()
    .toLowerCase();
  let temperature: number | null;
  if (tempArg === "none" || tempArg === "default" || tempArg === "off") {
    temperature = null;
  } else {
    const n = Number(tempArg);
    if (!Number.isFinite(n) || n < 0 || n > 2) {
      return `--temperature must be a number in [0, 2] or "none" (got "${String(v.temperature)}")`;
    }
    temperature = n;
  }

  const stamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace(/T/, "_")
    .slice(0, 16);
  const defaultOutput = path.join(
    process.env.HOME ?? ".",
    "gaia-runs",
    `${stamp}-${levelArg}`,
  );

  return {
    dataset: path.resolve(v.dataset as string),
    output: path.resolve((v.output as string | undefined) ?? defaultOutput),
    level,
    limit,
    provider: v.provider as string,
    apiKey,
    model: v.model as string,
    baseUrl: v["base-url"] as string | undefined,
    temperature,
    smoke,
    help: false,
  };
};

const formatDuration = (ms: number): string => {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rs = (s - m * 60).toFixed(0);
  return `${m}m${rs}s`;
};

const main = async (): Promise<number> => {
  const parsed = parseFlags(process.argv.slice(2));
  if (parsed === "__help__") {
    process.stdout.write(HELP);
    return 0;
  }
  if (typeof parsed === "string") {
    process.stderr.write(`gaia-eval: ${parsed}\n\n${HELP}`);
    return 1;
  }

  process.stdout.write(`[gaia] dataset:  ${parsed.dataset}\n`);
  process.stdout.write(`[gaia] output:   ${parsed.output}\n`);
  const tempLabel =
    parsed.temperature === null ? "omitted" : parsed.temperature;
  process.stdout.write(
    `[gaia] level=${parsed.level} limit=${parsed.limit ?? "all"} provider=${parsed.provider} model=${parsed.model} temperature=${tempLabel}\n\n`,
  );

  const startMs = Date.now();

  try {
    const { summary } = await runGaia({
      datasetDir: parsed.dataset,
      outputDir: parsed.output,
      level: parsed.level,
      limit: parsed.limit,
      provider: parsed.provider,
      apiKey: parsed.apiKey,
      model: parsed.model,
      baseUrl: parsed.baseUrl,
      temperature: parsed.temperature,
      onProgress: ({ index, total, result }) => {
        const mark = result.passed ? "✓" : "✗";
        const dur = formatDuration(result.durationMs);
        process.stdout.write(
          `[${(index + 1).toString().padStart(3)}/${total}] ${mark} L${result.level} ${result.taskId.slice(0, 8)} ${dur} — ${
            result.predicted?.slice(0, 60) ?? "<no answer>"
          }\n`,
        );
      },
    });

    process.stdout.write(
      `\n[gaia] done in ${formatDuration(Date.now() - startMs)}\n`,
    );
    process.stdout.write(
      `[gaia] ${summary.totals.passed}/${summary.totals.questions} passed (accuracy ${(summary.accuracy * 100).toFixed(1)}%)\n`,
    );
    for (const [lvl, stats] of Object.entries(summary.byLevel)) {
      process.stdout.write(
        `[gaia]   L${lvl}: ${stats.passed}/${stats.n} (${(stats.accuracy * 100).toFixed(1)}%)\n`,
      );
    }
    if (Object.keys(summary.failureTags).length > 0) {
      process.stdout.write(`[gaia] failure tags:\n`);
      for (const [tag, count] of Object.entries(summary.failureTags)) {
        process.stdout.write(`[gaia]   ${tag}: ${count}\n`);
      }
    }
    process.stdout.write(`\n[gaia] summary: ${parsed.output}/summary.json\n`);
    return 0;
  } catch (err) {
    process.stderr.write(
      `[gaia] runtime error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    if (err instanceof Error && err.stack) {
      process.stderr.write(`${err.stack}\n`);
    }
    return 2;
  }
};

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`[gaia] fatal: ${String(err)}\n`);
    process.exit(2);
  },
);
