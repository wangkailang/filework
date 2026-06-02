/**
 * Provider 适配器注册表
 *
 * 将 provider 名称映射到对应的适配器实现。
 * 新增一个 provider 只需创建一个新的适配器文件
 * 并在此处注册即可。
 */

import type { ProviderAdapter, ProviderConfig } from "./base";

export type { CacheMetrics, ProviderAdapter, ProviderConfig } from "./base";

import { AnthropicAdapter } from "./anthropic";
import { DeepSeekAdapter } from "./deepseek";
import { maybeWrapWithDevtools } from "./devtools";
import { OpenAIAdapter } from "./openai";
import { XiaomiAdapter } from "./xiaomi";

// ---------------------------------------------------------------------------
// 注册表
// ---------------------------------------------------------------------------

const openaiAdapter = new OpenAIAdapter();

const deepseekAdapter = new DeepSeekAdapter();

const adapters: Record<string, ProviderAdapter> = {
  anthropic: new AnthropicAdapter(),
  deepseek: deepseekAdapter,
  openai: openaiAdapter,
  // "custom"、"ollama" 和 "minimax" 共用 OpenAI 适配器 —— 它们都暴露
  // OpenAI 兼容的 /v1/chat/completions 端点。baseUrl 的解析
  //(例如 MiniMax 的默认区域)在上游的 ai-models.ts 中处理。
  custom: openaiAdapter,
  ollama: openaiAdapter,
  minimax: openaiAdapter,
  // Xiaomi MiMo 使用与 DeepSeek-Reasoner 相同的传输协议,但要求
  // 每一轮 assistant 消息(不只是最新一轮)都携带 `reasoning_content`。
  // deepseek 适配器会丢弃历史 reasoning。XiaomiAdapter 用一个 fetch
  // 拦截器包装 deepseek,将从原始 prompt 中捕获的 reasoning 重新写回
  // —— 详见 xiaomi.ts 顶部说明。
  xiaomi: new XiaomiAdapter(),
};

// 这些主机的 API 要求在每一轮后续对话中都把 reasoning_content 回传到
// assistant 消息里。OpenAI 适配器在消息转换时会静默丢弃 reasoning 片段,
// 因此任何指向这些端点的 custom/openai 类型配置,一旦模型产生 reasoning
// 就会返回 400。将这些请求强制路由到 DeepSeek 适配器(它是我们拥有的
// 唯一一个能保留 reasoning_content 的 OpenAI 兼容适配器)。
const REASONING_HOST_PATTERNS = [/(^|\.)xiaomimimo\.com$/i];

function isReasoningPassThroughHost(baseUrl: string | null | undefined) {
  if (!baseUrl) return false;
  try {
    const host = new URL(baseUrl).hostname;
    return REASONING_HOST_PATTERNS.some((rx) => rx.test(host));
  } catch {
    return false;
  }
}

/**
 * 从 provider 配置中解析出规范的适配器名称,并对需要特殊处理的端点
 *(例如 Xiaomi MiMo 的 reasoning_content 往返)应用基于 URL 的覆盖。
 */
export function resolveAdapterName(
  provider: string,
  baseUrl?: string | null,
): string {
  if (provider !== "xiaomi" && isReasoningPassThroughHost(baseUrl)) {
    return "xiaomi";
  }
  return provider;
}

/**
 * 根据 provider 名称获取对应的适配器。
 * 对于未知 provider,回退到 OpenAI 适配器
 *(OpenAI 兼容是最常见的回退方案)。
 */
export function getAdapter(provider: string): ProviderAdapter {
  return adapters[provider] ?? adapters.openai;
}

/**
 * 从 provider 配置创建 model + adapter 组合。
 * 将适配器查找与模型创建结合在一起的便捷函数。
 */
export function createModelWithAdapter(config: ProviderConfig) {
  const resolved = resolveAdapterName(config.provider, config.baseUrl);
  const adapter = getAdapter(resolved);
  // devtools 中间件套在最外层,确保覆盖到已被各 adapter(如 xiaomi)包装过的模型。
  const model = maybeWrapWithDevtools(adapter.createModel(config));
  return { model, adapter };
}
