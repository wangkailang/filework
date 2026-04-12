/**
 * Preprocessor module for AI Skills Runtime.
 *
 * Handles argument substitution, dynamic context injection (!command),
 * and content truncation before skill body is injected as a system prompt.
 */

import { exec } from "node:child_process";
import type { TrustLevel } from "./security";
import { buildSafeEnv, isCommandAllowed } from "./security";
import type { PreprocessResult } from "./types";

/** Default timeout for !command execution (ms). */
const DEFAULT_TIMEOUT_MS = 10_000;

/** Default maximum character count before truncation. */
const DEFAULT_MAX_CHARS = 20_000;

/**
 * Execute a shell command asynchronously with timeout support.
 *
 * Uses `child_process.exec` wrapped in a Promise. The `timeout` option
 * causes the child process to be killed after the specified duration.
 */
function execCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  env: Record<string, string>,
): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(command, { cwd, timeout: timeoutMs, env }, (error, stdout, stderr) => {
      if (error) {
        // Node.js sets error.killed when the process was killed due to timeout
        if (error.killed) {
          reject(
            new Error(
              `command timed out after ${Math.round(timeoutMs / 1000)}s`,
            ),
          );
        } else {
          const reason = stderr?.trim() || error.message;
          reject(new Error(`command failed: ${reason}`));
        }
        return;
      }
      resolve(stdout);
    });
  });
}

/**
 * Preprocess a skill's body content before injection as a system prompt.
 *
 * Processing order:
 * 1. `$ARGUMENTS` → replaced with the full argument string
 * 2. `$ARGUMENTS[N]` / `$N` → replaced with the Nth space-split argument (0-indexed)
 * 3. `!command` → each line starting with `!` is executed as a shell command
 * 4. Truncation check → if result exceeds `maxChars`, truncate and append marker
 *
 * @param body - The raw skill body (Markdown content)
 * @param args - The user-provided argument string
 * @param workspacePath - The workspace root directory for command execution
 * @param options - Optional configuration overrides
 */
export async function preprocessSkill(
  body: string,
  args: string,
  workspacePath: string,
  options?: {
    timeoutMs?: number;
    maxChars?: number;
    sourcePath?: string;
    trustLevel?: TrustLevel;
  },
): Promise<PreprocessResult> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxChars = options?.maxChars ?? DEFAULT_MAX_CHARS;
  const sourcePath = options?.sourcePath ?? "";
  const trustLevel: TrustLevel = options?.trustLevel ?? "high";
  const warnings: string[] = [];

  // Split arguments by whitespace for indexed access
  const argParts = args.trim() ? args.trim().split(/\s+/) : [];

  // ── Step 1: Replace $ARGUMENTS with full argument string ──
  let result = body.replace(/\$ARGUMENTS(?!\[)/g, args);

  // ── Step 2: Replace $ARGUMENTS[N] and $N with Nth argument ──
  // $ARGUMENTS[N] — 0-indexed
  result = result.replace(/\$ARGUMENTS\[(\d+)\]/g, (_match, index) => {
    const i = parseInt(index, 10);
    if (i >= argParts.length) {
      warnings.push(
        `Argument index ${i} out of bounds (${argParts.length} args provided)`,
      );
      return "";
    }
    return argParts[i];
  });

  // $N — 0-indexed positional shorthand
  result = result.replace(/\$(\d+)/g, (_match, index) => {
    const i = parseInt(index, 10);
    if (i >= argParts.length) {
      warnings.push(
        `Argument index ${i} out of bounds (${argParts.length} args provided)`,
      );
      return "";
    }
    return argParts[i];
  });

  // ── Step 3: Execute !command lines ──
  const safeEnv = buildSafeEnv();
  const lines = result.split("\n");
  const processedLines: string[] = [];

  for (const line of lines) {
    // A !command line starts with `!` (optionally preceded by whitespace)
    const commandMatch = line.match(/^(\s*)!(.+)$/);
    if (!commandMatch) {
      processedLines.push(line);
      continue;
    }

    const command = commandMatch[2].trim();

    // Check if the command is allowed
    if (!isCommandAllowed(command, trustLevel)) {
      processedLines.push("[Blocked: command not allowed]");
      warnings.push(`Command blocked: ${command}`);
      continue;
    }

    // Execute the command
    try {
      const output = await execCommand(
        command,
        workspacePath,
        timeoutMs,
        safeEnv,
      );
      processedLines.push(output.trimEnd());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      processedLines.push(`[Error: ${message}]`);
      warnings.push(`Command error: ${message}`);
    }
  }

  result = processedLines.join("\n");

  // ── Step 4: Truncation check ──
  let truncated = false;
  if (result.length > maxChars) {
    truncated = true;
    const marker = sourcePath
      ? `\n[...truncated, read full content from: ${sourcePath}]`
      : "\n[...truncated]";
    result = result.slice(0, maxChars) + marker;
  }

  return {
    systemPrompt: result,
    truncated,
    warnings,
  };
}
