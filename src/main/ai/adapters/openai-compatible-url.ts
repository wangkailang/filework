const CHAT_COMPLETIONS_SUFFIX = "/chat/completions";

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

function normalizePath(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function appendPath(baseUrl: string, pathPrefix: string): string {
  const base = new URL(baseUrl);
  const basePath = trimTrailingSlashes(base.pathname);
  const normalizedPrefix = normalizePath(pathPrefix);

  if (basePath === normalizedPrefix || basePath.endsWith(normalizedPrefix)) {
    return trimTrailingSlashes(base.toString());
  }

  base.pathname = `${basePath}${normalizedPrefix}`;
  return trimTrailingSlashes(base.toString());
}

export function resolveOpenAICompatibleBaseUrl(
  baseUrl: string | null | undefined,
  apiPath: string | null | undefined,
): string | undefined {
  if (!baseUrl?.trim()) return undefined;

  const normalizedBase = trimTrailingSlashes(baseUrl.trim());
  if (!apiPath?.trim()) return normalizedBase;

  const normalizedPath = normalizePath(apiPath);
  if (!normalizedPath.toLowerCase().endsWith(CHAT_COMPLETIONS_SUFFIX)) {
    return normalizedBase;
  }

  const prefix = trimTrailingSlashes(
    normalizedPath.slice(0, -CHAT_COMPLETIONS_SUFFIX.length),
  );
  if (!prefix) return normalizedBase;

  try {
    return appendPath(normalizedBase, prefix);
  } catch {
    return `${normalizedBase}${normalizePath(prefix)}`;
  }
}

export function resolveOpenAICompatibleChatCompletionsUrl(
  baseUrl: string | null | undefined,
  apiPath: string | null | undefined,
): string {
  const resolvedBaseUrl = resolveOpenAICompatibleBaseUrl(baseUrl, apiPath);
  if (!resolvedBaseUrl) {
    throw new Error("baseUrl is required");
  }
  return `${trimTrailingSlashes(resolvedBaseUrl)}${CHAT_COMPLETIONS_SUFFIX}`;
}
