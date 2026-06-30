import type { ContextCompressedPart, MessagePart } from "./types";

const readTokenCount = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;

export const readContextCompressionDetail = (
  detail: Record<string, unknown>,
): Pick<ContextCompressedPart, "compressedTokens" | "originalTokens"> => ({
  originalTokens: readTokenCount(detail.originalTokens),
  compressedTokens: readTokenCount(detail.compressedTokens),
});

export const upsertContextCompressedPart = (
  parts: MessagePart[],
  detail: Pick<ContextCompressedPart, "compressedTokens" | "originalTokens">,
): MessagePart[] => {
  const marker: ContextCompressedPart = {
    type: "context-compressed",
    originalTokens: detail.originalTokens,
    compressedTokens: detail.compressedTokens,
  };
  const existingIdx = parts.findIndex(
    (part) => part.type === "context-compressed",
  );
  if (existingIdx >= 0) {
    const next = [...parts];
    next[existingIdx] = marker;
    return next;
  }
  return [marker, ...parts];
};
