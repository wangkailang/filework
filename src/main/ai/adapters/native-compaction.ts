import type { JSONObject, ProviderConfig, ProviderOptionMap } from "./base";

export type ProviderNativeCompaction =
  | {
      enabled: true;
      mode: "openai-truncation-auto";
      provider: "openai";
      triggerTokens: null;
    }
  | {
      enabled: true;
      mode: "anthropic-context-management-compact";
      provider: "anthropic";
      triggerTokens: number | null;
    }
  | {
      enabled: false;
      provider: string;
      reason: "unsupported-api" | "unsupported-provider";
    };

export interface ProviderNativeCompactionUsage {
  applied: boolean;
  mode: "anthropic-context-management-compact" | "openai-truncation-auto";
  provider: "anthropic" | "openai";
}

export function getProviderNativeCompaction(
  config: Pick<
    ProviderConfig,
    "baseUrl" | "compressionTriggerBudget" | "modelCapabilities" | "provider"
  >,
): ProviderNativeCompaction {
  if (config.provider === "anthropic") {
    return {
      enabled: true,
      mode: "anthropic-context-management-compact",
      provider: "anthropic",
      triggerTokens: normalizeTrigger(config.compressionTriggerBudget),
    };
  }

  if (config.provider === "openai") {
    const isOfficialOpenAIEndpoint =
      config.baseUrl == null || config.baseUrl.includes("api.openai.com");
    if (!isOfficialOpenAIEndpoint) {
      return {
        enabled: false,
        provider: config.provider,
        reason: "unsupported-provider",
      };
    }
    if (config.modelCapabilities?.preferredApi === "chat_completions") {
      return {
        enabled: false,
        provider: config.provider,
        reason: "unsupported-api",
      };
    }
    return {
      enabled: true,
      mode: "openai-truncation-auto",
      provider: "openai",
      triggerTokens: null,
    };
  }

  return {
    enabled: false,
    provider: config.provider,
    reason: "unsupported-provider",
  };
}

export function buildProviderNativeCompactionOptions(
  config: Pick<
    ProviderConfig,
    "baseUrl" | "compressionTriggerBudget" | "modelCapabilities" | "provider"
  >,
): ProviderOptionMap {
  const native = getProviderNativeCompaction(config);
  if (!native.enabled) return {};

  if (native.provider === "openai") {
    return { openai: { truncation: "auto" } };
  }

  const edit: JSONObject = {
    type: "compact_20260112",
    pauseAfterCompaction: false,
    ...(native.triggerTokens != null && {
      trigger: { type: "input_tokens", value: native.triggerTokens },
    }),
  };

  return {
    anthropic: {
      contextManagement: {
        edits: [edit],
      },
    },
  };
}

export function extractProviderNativeCompactionUsage(
  providerMetadata: Record<string, unknown> | undefined,
): ProviderNativeCompactionUsage | null {
  const anthropic = providerMetadata?.anthropic as
    | Record<string, unknown>
    | undefined;
  const contextManagement = anthropic?.contextManagement as
    | Record<string, unknown>
    | undefined;
  const appliedEdits = contextManagement?.appliedEdits;

  if (
    Array.isArray(appliedEdits) &&
    appliedEdits.some(
      (edit) =>
        edit != null &&
        typeof edit === "object" &&
        (edit as { type?: unknown }).type === "compact_20260112",
    )
  ) {
    return {
      applied: true,
      mode: "anthropic-context-management-compact",
      provider: "anthropic",
    };
  }

  return null;
}

function normalizeTrigger(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : null;
}
