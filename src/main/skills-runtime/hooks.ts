/**
 * Hooks module for AI Skills Runtime.
 *
 * Executes lifecycle hook scripts (pre-activate, post-complete) defined
 * in a skill's frontmatter. Hook failures are logged but never interrupt
 * the main skill execution flow.
 */

import { exec } from "node:child_process";
import { resolve } from "node:path";

import { buildSafeEnv } from "./security";

/** Default timeout for hook script execution (ms). */
const DEFAULT_HOOK_TIMEOUT_MS = 30_000;

/**
 * Execute a hook script associated with a skill.
 *
 * The hook script path is resolved relative to the skill directory,
 * and the script runs with the workspace root as its working directory.
 * A safe environment (sensitive vars filtered) is used for the subprocess.
 *
 * Hook failures are caught and returned as `{ success: false, error }` —
 * they NEVER throw or interrupt the caller.
 *
 * @param hookScript - Relative path to the hook script (e.g. `./scripts/setup.sh`)
 * @param skillDir - Absolute path to the skill directory
 * @param workspacePath - Absolute path to the workspace root (used as cwd)
 * @param timeoutMs - Maximum execution time in milliseconds (default 30 s)
 */
export async function runHook(
  hookScript: string,
  skillDir: string,
  workspacePath: string,
  timeoutMs: number = DEFAULT_HOOK_TIMEOUT_MS,
): Promise<{ success: boolean; output?: string; error?: string }> {
  try {
    const scriptPath = resolve(skillDir, hookScript);
    const safeEnv = buildSafeEnv();

    const stdout = await new Promise<string>((resolvePromise, reject) => {
      exec(
        scriptPath,
        { cwd: workspacePath, timeout: timeoutMs, env: safeEnv },
        (error, stdout, _stderr) => {
          if (error) {
            if (error.killed) {
              reject(new Error("timed out"));
            } else {
              const reason = _stderr?.trim() || error.message;
              reject(new Error(reason));
            }
            return;
          }
          resolvePromise(stdout);
        },
      );
    });

    return { success: true, output: stdout };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[skills-hooks] Hook "${hookScript}" failed: ${message}`);
    return { success: false, error: message };
  }
}
