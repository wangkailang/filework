#!/usr/bin/env node
/**
 * `pnpm gaia-eval-diff` 入口点。
 *
 *   pnpm gaia-eval-diff <baseline-dir> <current-dir> [--output <path>]
 *
 * 默认输出:将 `diff-vs-baseline.md` 写入当前运行的
 * 目录(使其与该运行的 summary.json 相邻,并随
 * 该运行一起移动)。
 *
 * 退出码:
 *   0 — diff 渲染成功
 *   1 — 配置错误 / 目录缺失
 *   2 — 运行时错误
 */

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

import { computeDiff, formatDiffMarkdown, loadRun } from "./diff";

const HELP = `gaia-eval-diff — compare two GAIA run output dirs.

Usage:
  pnpm gaia-eval-diff <baseline-dir> <current-dir> [--output <path>]

Args:
  <baseline-dir>   Run directory to treat as the reference (older run).
  <current-dir>    Run directory to compare against the baseline.

Optional:
  --output <path>  Where to write the Markdown report.
                   Default: <current-dir>/diff-vs-baseline.md
  --stdout         Also print the report to stdout.

Example:
  pnpm gaia-eval-diff \\
    ~/gaia-runs/2026-05-17_19-00-1 \\
    ~/gaia-runs/2026-05-18_10-30-1
`;

interface ParsedDiffFlags {
  baselineDir: string;
  currentDir: string;
  outputPath: string;
  alsoStdout: boolean;
}

const parseFlags = (argv: string[]): ParsedDiffFlags | string => {
  const options = {
    output: { type: "string" as const },
    stdout: { type: "boolean" as const, default: false },
    help: { type: "boolean" as const, default: false, short: "h" },
  };
  let parsed: { values: Record<string, unknown>; positionals: string[] };
  try {
    parsed = parseArgs({ args: argv, options, allowPositionals: true });
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  if (parsed.values.help) return "__help__";

  const positionals = parsed.positionals;
  if (positionals.length !== 2) {
    return "expected exactly two positional args: <baseline-dir> <current-dir>";
  }
  const baselineDir = path.resolve(positionals[0]);
  const currentDir = path.resolve(positionals[1]);
  const outputPath = parsed.values.output
    ? path.resolve(parsed.values.output as string)
    : path.join(currentDir, "diff-vs-baseline.md");

  return {
    baselineDir,
    currentDir,
    outputPath,
    alsoStdout: Boolean(parsed.values.stdout),
  };
};

const main = async (): Promise<number> => {
  const parsed = parseFlags(process.argv.slice(2));
  if (parsed === "__help__") {
    process.stdout.write(HELP);
    return 0;
  }
  if (typeof parsed === "string") {
    process.stderr.write(`gaia-eval-diff: ${parsed}\n\n${HELP}`);
    return 1;
  }

  try {
    const [baseline, current] = await Promise.all([
      loadRun(parsed.baselineDir),
      loadRun(parsed.currentDir),
    ]);
    const diff = computeDiff(baseline, current);
    const md = formatDiffMarkdown(diff);
    await writeFile(parsed.outputPath, md, "utf-8");

    process.stdout.write(`[gaia-diff] wrote ${parsed.outputPath}\n`);
    process.stdout.write(
      `[gaia-diff] accuracy ${(baseline.summary.accuracy * 100).toFixed(1)}% → ${(current.summary.accuracy * 100).toFixed(1)}% ` +
        `(${diff.accuracyDelta >= 0 ? "+" : ""}${(diff.accuracyDelta * 100).toFixed(1)} pp)\n`,
    );
    process.stdout.write(
      `[gaia-diff] newly passed: ${diff.newlyPassed.length}, regressions: ${diff.regressions.length}\n`,
    );
    if (parsed.alsoStdout) {
      process.stdout.write("\n");
      process.stdout.write(md);
    }
    return 0;
  } catch (err) {
    process.stderr.write(
      `[gaia-diff] error: ${err instanceof Error ? err.message : String(err)}\n`,
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
    process.stderr.write(`[gaia-diff] fatal: ${String(err)}\n`);
    process.exit(2);
  },
);
