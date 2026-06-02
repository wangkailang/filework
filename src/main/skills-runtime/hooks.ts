/**
 * AI 技能运行时的钩子模块。
 *
 * 执行技能 frontmatter 中定义的生命周期钩子脚本(pre-activate、post-complete)。
 * 钩子失败会被记录,但绝不会中断主技能执行流程。
 */

import { exec } from "node:child_process";
import { resolve } from "node:path";

import { buildSafeEnv } from "./security";

/** 钩子脚本执行的默认超时(毫秒)。 */
const DEFAULT_HOOK_TIMEOUT_MS = 30_000;

/**
 * 执行与某个技能关联的钩子脚本。
 *
 * 钩子脚本路径相对于技能目录解析,
 * 脚本以工作区根目录作为其工作目录运行。
 * 子进程使用安全环境(已过滤敏感变量)。
 *
 * 钩子失败会被捕获并以 `{ success: false, error }` 形式返回 ——
 * 它们绝不会抛出异常或中断调用方。
 *
 * @param hookScript - 钩子脚本的相对路径(如 `./scripts/setup.sh`)
 * @param skillDir - 技能目录的绝对路径
 * @param workspacePath - 工作区根目录的绝对路径(用作 cwd)
 * @param timeoutMs - 最大执行时间,单位毫秒(默认 30 秒)
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
