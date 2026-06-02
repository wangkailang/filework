/**
 * AI 技能运行时的预处理器模块。
 *
 * 在技能正文作为系统提示词注入之前,处理参数替换、
 * 动态上下文注入(!command)以及内容截断。
 */

import { exec } from "node:child_process";
import type { TrustLevel } from "./security";
import { buildSafeEnv, isCommandAllowed } from "./security";
import type { PreprocessResult } from "./types";

/** !command 执行的默认超时(毫秒)。 */
const DEFAULT_TIMEOUT_MS = 10_000;

/** 触发截断前的默认最大字符数。 */
const DEFAULT_MAX_CHARS = 20_000;

/**
 * 异步执行 shell 命令,支持超时。
 *
 * 使用包裹在 Promise 中的 `child_process.exec`。`timeout` 选项
 * 会在指定时长后杀掉子进程。
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
        // 当进程因超时被杀掉时,Node.js 会设置 error.killed
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
 * 在技能正文内容作为系统提示词注入之前对其进行预处理。
 *
 * 处理顺序:
 * 1. `$ARGUMENTS` → 替换为完整的参数字符串
 * 2. `$ARGUMENTS[N]` / `$N` → 替换为按空格切分的第 N 个参数(从 0 开始)
 * 3. `!command` → 每个以 `!` 开头的行都作为 shell 命令执行
 * 4. 截断检查 → 若结果超过 `maxChars`,则截断并追加标记
 *
 * @param body - 原始技能正文(Markdown 内容)
 * @param args - 用户提供的参数字符串
 * @param workspacePath - 命令执行所用的工作区根目录
 * @param options - 可选的配置覆盖项
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

  // 按空白字符切分参数以便按索引访问
  const argParts = args.trim() ? args.trim().split(/\s+/) : [];

  // ── 步骤 1:将 $ARGUMENTS 替换为完整参数字符串 ──
  let result = body.replace(/\$ARGUMENTS(?!\[)/g, args);

  // ── 步骤 2:将 $ARGUMENTS[N] 和 $N 替换为第 N 个参数 ──
  // $ARGUMENTS[N] —— 从 0 开始索引
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

  // $N —— 从 0 开始索引的位置参数简写
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

  // ── 步骤 3:执行 !command 行 ──
  const safeEnv = buildSafeEnv();
  const lines = result.split("\n");
  const processedLines: string[] = [];

  for (const line of lines) {
    // !command 行以 `!` 开头(前面可以有空白)
    const commandMatch = line.match(/^(\s*)!(.+)$/);
    if (!commandMatch) {
      processedLines.push(line);
      continue;
    }

    const command = commandMatch[2].trim();

    // 检查该命令是否被允许
    if (!isCommandAllowed(command, trustLevel)) {
      processedLines.push("[Blocked: command not allowed]");
      warnings.push(`Command blocked: ${command}`);
      continue;
    }

    // 执行命令
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

  // ── 步骤 4:截断检查 ──
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
