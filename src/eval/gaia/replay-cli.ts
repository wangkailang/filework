#!/usr/bin/env node
/**
 * `pnpm gaia-eval-replay` entry point — three modes:
 *
 *   1. Single trajectory:
 *      pnpm gaia-eval-replay <events.jsonl>
 *
 *   2. Pair diff (two events.jsonl):
 *      pnpm gaia-eval-replay <baseline.jsonl> <current.jsonl>
 *
 *   3. Batch (two run output dirs):
 *      pnpm gaia-eval-replay --batch <baseline-dir> <current-dir> [--output <path>]
 *
 * Exit codes:
 *   0 — single signature printed, or no drift detected
 *   1 — config error
 *   2 — runtime error
 *   3 — trajectory drift detected (pair or batch mode)
 *
 * The non-zero "drift" exit code is intentional: it lets CI gate on
 * "trajectory must be identical" when running deterministic fixtures.
 */

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

import {
  computeSignature,
  diffSignatures,
  formatBatchReport,
  formatSignature,
  formatSignatureDiff,
  loadEventStream,
  runBatchReplay,
} from "./replay";

const HELP = `gaia-eval-replay — inspect & diff GAIA agent trajectories.

Usage:
  pnpm gaia-eval-replay <events.jsonl>                          # single
  pnpm gaia-eval-replay <baseline.jsonl> <current.jsonl>        # pair diff
  pnpm gaia-eval-replay --batch <baseline-dir> <current-dir>    # batch

Options:
  --output <path>   In batch mode, write the markdown report to <path>.
                    Default: <current-dir>/replay-vs-baseline.md
  --json            Print signature as JSON (single mode only).
  -h, --help        Show this help.

Why:
  GAIA score moves can be either (a) the LLM acting differently or
  (b) your agent-loop / reflection-gate code changes. Replay extracts a
  deterministic fingerprint from events.jsonl so you can answer "did
  the path actually change?" without spending another $0.20 on a
  baseline rerun.
`;

type Mode = "help" | "single" | "pair" | "batch" | "error";

const inferMode = (
  positionals: readonly string[],
  isBatch: boolean,
  isHelp: boolean,
): Mode => {
  if (isHelp) return "help";
  if (isBatch) return positionals.length === 2 ? "batch" : "error";
  if (positionals.length === 1) return "single";
  if (positionals.length === 2) return "pair";
  return "error";
};

const main = async (): Promise<number> => {
  let parsed: { values: Record<string, unknown>; positionals: string[] };
  try {
    parsed = parseArgs({
      args: process.argv.slice(2),
      options: {
        batch: { type: "boolean" as const, default: false },
        output: { type: "string" as const },
        json: { type: "boolean" as const, default: false },
        help: { type: "boolean" as const, default: false, short: "h" },
      },
      allowPositionals: true,
    });
  } catch (err) {
    process.stderr.write(
      `gaia-eval-replay: ${err instanceof Error ? err.message : String(err)}\n\n${HELP}`,
    );
    return 1;
  }
  const mode = inferMode(
    parsed.positionals,
    Boolean(parsed.values.batch),
    Boolean(parsed.values.help),
  );
  if (mode === "help") {
    process.stdout.write(HELP);
    return 0;
  }
  if (mode === "error") {
    process.stderr.write(`gaia-eval-replay: invalid arguments\n\n${HELP}`);
    return 1;
  }

  try {
    if (mode === "single") {
      const filePath = path.resolve(parsed.positionals[0]);
      const taskId = path.basename(filePath, ".jsonl");
      const events = await loadEventStream(filePath);
      const sig = computeSignature(taskId, events);
      if (parsed.values.json) {
        process.stdout.write(`${JSON.stringify(sig, null, 2)}\n`);
      } else {
        process.stdout.write(`${formatSignature(sig)}\n`);
      }
      return 0;
    }

    if (mode === "pair") {
      const [aPath, bPath] = parsed.positionals.map((p) => path.resolve(p));
      const aId = path.basename(aPath, ".jsonl");
      const bId = path.basename(bPath, ".jsonl");
      const [aEvents, bEvents] = await Promise.all([
        loadEventStream(aPath),
        loadEventStream(bPath),
      ]);
      const sigId = aId === bId ? aId : `${aId} ↔ ${bId}`;
      const diff = diffSignatures(
        computeSignature(sigId, aEvents),
        computeSignature(sigId, bEvents),
      );
      process.stdout.write(`${formatSignatureDiff(diff)}\n`);
      return diff.identical ? 0 : 3;
    }

    const [baselineDir, currentDir] = parsed.positionals.map((p) =>
      path.resolve(p),
    );
    const outputPath = parsed.values.output
      ? path.resolve(parsed.values.output as string)
      : path.join(currentDir, "replay-vs-baseline.md");
    const report = await runBatchReplay(baselineDir, currentDir);
    const md = formatBatchReport(report);
    await writeFile(outputPath, md, "utf-8");
    process.stdout.write(`[gaia-replay] wrote ${outputPath}\n`);
    process.stdout.write(
      `[gaia-replay] identical: ${report.identical}, changed: ${report.changed}, ` +
        `coverage drift: ${report.missingInBaseline + report.missingInCurrent}, errors: ${report.errors}\n`,
    );
    return report.changed > 0 ? 3 : 0;
  } catch (err) {
    process.stderr.write(
      `[gaia-replay] error: ${err instanceof Error ? err.message : String(err)}\n`,
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
    process.stderr.write(`[gaia-replay] fatal: ${String(err)}\n`);
    process.exit(2);
  },
);
