/**
 * @ai-sdk/devtools 接入:用 wrapLanguageModel 在主进程拦截所有 streamText/
 * generateText 调用,把每轮 LLM 请求/响应/用量写入 .devtools/generations.json,
 * 并通过 npx @ai-sdk/devtools(localhost:4983)的面板可视化分析。
 *
 * 仅在开发环境 + 显式 opt-in 时启用:
 * - devToolsMiddleware() 在 NODE_ENV=production 时会直接 throw;
 * - 它把完整请求/响应明文落盘,属敏感数据,故默认关闭,靠 FILEWORK_AI_DEVTOOLS=1 打开,
 *   平时零开销、不落盘。
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { statSync } from "node:fs";
import { join } from "node:path";
import { devToolsMiddleware } from "@ai-sdk/devtools";
import { type LanguageModel, wrapLanguageModel } from "ai";

const DEVTOOLS_GENERATIONS_LOG_PATH = ".devtools/generations.json";
const DEVTOOLS_GENERATIONS_LOG_MAX_BYTES = 100 * 1024 * 1024;

type DevtoolsState =
  | { enabled: true }
  | {
      enabled: false;
      message?: string;
      reason:
        | "generations-log-too-large"
        | "generations-log-unavailable"
        | "not-opted-in"
        | "production";
    };

type ResolveDevtoolsStateOptions = {
  cwd?: string;
  env?: {
    FILEWORK_AI_DEVTOOLS?: string;
    NODE_ENV?: string;
  };
};

function formatMegabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function resolveDevtoolsState({
  cwd = process.cwd(),
  env = process.env,
}: ResolveDevtoolsStateOptions = {}): DevtoolsState {
  if (env.NODE_ENV === "production") {
    return { enabled: false, reason: "production" };
  }
  if (env.FILEWORK_AI_DEVTOOLS !== "1") {
    return { enabled: false, reason: "not-opted-in" };
  }

  const logPath = join(cwd, DEVTOOLS_GENERATIONS_LOG_PATH);
  try {
    const stats = statSync(logPath);
    if (!stats.isFile() || stats.size <= DEVTOOLS_GENERATIONS_LOG_MAX_BYTES) {
      return { enabled: true };
    }

    return {
      enabled: false,
      message:
        `[ai-devtools] 已禁用: ${DEVTOOLS_GENERATIONS_LOG_PATH} 当前 ${formatMegabytes(stats.size)}, ` +
        `超过 100MB 阈值。请先清理旧日志: rm -f ${DEVTOOLS_GENERATIONS_LOG_PATH}, ` +
        "再重新运行 pnpm dev:devtools。",
      reason: "generations-log-too-large",
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { enabled: true };
    }

    return {
      enabled: false,
      message:
        `[ai-devtools] 已禁用: 无法读取 ${DEVTOOLS_GENERATIONS_LOG_PATH} (${code ?? "unknown"}). ` +
        "请检查或清理该文件后重新运行 pnpm dev:devtools。",
      reason: "generations-log-unavailable",
    };
  }
}

let disabledWarning: string | null = null;

function warnDisabledOnce(message: string): void {
  if (disabledWarning === message) return;
  disabledWarning = message;
  console.warn(message);
}

function devtoolsEnabled(): boolean {
  const state = resolveDevtoolsState();
  if (!state.enabled && state.message) {
    warnDisabledOnce(state.message);
  }
  return state.enabled;
}

// 每个 devToolsMiddleware() 实例 = devtools 里的一个独立 run。为让「一个用户任务」
// 的所有 LLM 调用(主循环 + 结果摘要 + 上下文压缩 + 重试)归到同一个 run(对齐
// Claude Code / Codex「一次会话一条线」的心智),用任务级 AsyncLocalStorage 缓存
// 同一个 middleware:同任务内复用,任务外的零散调用各自独立 run。
type TaskScope = { middleware: ReturnType<typeof devToolsMiddleware> | null };
const taskScope = new AsyncLocalStorage<TaskScope>();

/**
 * 在一个任务作用域内执行 fn:其内部(含 await 链)所有 maybeWrapWithDevtools 共享
 * 同一个 devtools run。未启用 devtools 时零开销直通。
 */
export function runWithDevtoolsTaskScope<T>(fn: () => T): T {
  if (!devtoolsEnabled()) return fn();
  return taskScope.run({ middleware: null }, fn);
}

function resolveMiddleware(): ReturnType<typeof devToolsMiddleware> {
  const scope = taskScope.getStore();
  if (scope) {
    // 同任务复用:首次惰性创建,后续命中缓存 → 同一个 run。
    scope.middleware ??= devToolsMiddleware();
    return scope.middleware;
  }
  // 任务作用域外:各自独立 run。
  return devToolsMiddleware();
}

// 首次激活时打印一次提示(在建模时执行,此刻 dotenv 已加载完 .env,
// 避免在模块导入期读到尚未注入的 env)。给用户明确反馈:已激活 + 如何查看。
let announced = false;

function announceOnce(): void {
  if (announced) return;
  announced = true;
  const port = process.env.AI_SDK_DEVTOOLS_PORT ?? "4983";
  console.log(
    `[ai-devtools] 已激活(FILEWORK_AI_DEVTOOLS=1):LLM 日志写入 .devtools/generations.json;发消息后刷新 http://localhost:${port} 查看。`,
  );
}

/**
 * 若已 opt-in,则给模型套一层 devtools 中间件;否则原样返回。
 * 每次建模调用一次工厂 → 每个模型实例对应一个独立 run(一次任务的多轮归为一组)。
 */
export function maybeWrapWithDevtools(model: LanguageModel): LanguageModel {
  if (!devtoolsEnabled()) return model;
  // LanguageModel 是 string | V2 | V3 联合:gateway 字符串 id 无从包装;
  // devToolsMiddleware 是 v3 中间件,只包 v3 模型(本项目所有 provider 均为 v3)。
  if (typeof model === "string" || model.specificationVersion !== "v3") {
    return model;
  }
  announceOnce();
  return wrapLanguageModel({ model, middleware: resolveMiddleware() });
}

export const __test__ = {
  DEVTOOLS_GENERATIONS_LOG_MAX_BYTES,
  resolveDevtoolsState,
};
