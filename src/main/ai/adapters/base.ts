/**
 * Provider 适配器基类
 *
 * 定义所有 provider 适配器必须实现的接口。
 * 每个适配器封装 provider 特有的事项:
 * - 模型实例化
 * - Provider 选项(例如 prompt 缓存)
 * - Provider 元数据提取(例如缓存命中 / 写入 token)
 */

import type { LanguageModel } from "ai";

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export interface ProviderConfig {
  provider: string;
  apiKey: string;
  resolveApiKey?: (options?: { forceRefresh?: boolean }) => Promise<string>;
  baseUrl?: string | null;
  apiPath?: string | null;
  model: string;
  modelCapabilities?: {
    preferredApi?: "chat_completions" | "responses" | null;
    supportsReasoning?: boolean | null;
    supportsTools?: boolean | null;
    supportsVision?: boolean | null;
  } | null;
}

export interface CacheMetrics {
  cacheWriteTokens: number | null;
  cacheReadTokens: number | null;
}

type JSONValue = null | string | number | boolean | JSONObject | JSONValue[];
type JSONObject = { [key: string]: JSONValue };

// ---------------------------------------------------------------------------
// 接口
// ---------------------------------------------------------------------------

export interface ProviderAdapter {
  /** 唯一的 provider 标识符 */
  readonly name: string;

  /** 根据 config 创建 LanguageModel 实例 */
  createModel(config: ProviderConfig): LanguageModel;

  /** 构建 provider 特有的选项(例如 prompt 缓存 headers) */
  buildProviderOptions(): Record<string, JSONObject>;

  /** 在流式响应完成后,从 provider 元数据中提取缓存指标 */
  extractCacheMetrics(
    providerMetadata: Record<string, unknown> | undefined,
  ): CacheMetrics;
}

// ---------------------------------------------------------------------------
// 可选方法的默认(空操作)实现
// ---------------------------------------------------------------------------

export const NO_CACHE_METRICS: CacheMetrics = {
  cacheWriteTokens: null,
  cacheReadTokens: null,
};

export const NO_PROVIDER_OPTIONS: Record<string, JSONObject> = {};
