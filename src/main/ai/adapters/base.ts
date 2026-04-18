/**
 * Provider Adapter Base
 *
 * Defines the interface all provider adapters must implement.
 * Each adapter encapsulates provider-specific concerns:
 * - Model instantiation
 * - Provider options (e.g. prompt caching)
 * - Provider metadata extraction (e.g. cache hit/write tokens)
 */

import type { LanguageModel } from "ai";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProviderConfig {
  provider: string;
  apiKey: string;
  baseUrl?: string | null;
  model: string;
}

export interface CacheMetrics {
  cacheWriteTokens: number | null;
  cacheReadTokens: number | null;
}

type JSONValue = null | string | number | boolean | JSONObject | JSONValue[];
type JSONObject = { [key: string]: JSONValue };

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface ProviderAdapter {
  /** Unique provider identifier */
  readonly name: string;

  /** Create a LanguageModel instance from config */
  createModel(config: ProviderConfig): LanguageModel;

  /** Build provider-specific options (e.g. prompt caching headers) */
  buildProviderOptions(): Record<string, JSONObject>;

  /** Extract cache metrics from provider metadata after a stream completes */
  extractCacheMetrics(
    providerMetadata: Record<string, unknown> | undefined,
  ): CacheMetrics;
}

// ---------------------------------------------------------------------------
// Default (no-op) implementations for optional methods
// ---------------------------------------------------------------------------

export const NO_CACHE_METRICS: CacheMetrics = {
  cacheWriteTokens: null,
  cacheReadTokens: null,
};

export const NO_PROVIDER_OPTIONS: Record<string, JSONObject> = {};
