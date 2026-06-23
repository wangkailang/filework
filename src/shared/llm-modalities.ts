export type SharedLlmModality = "chat" | "image" | "video";

const CHAT_ONLY: SharedLlmModality[] = ["chat"];
const CHAT_IMAGE: SharedLlmModality[] = ["chat", "image"];
const CHAT_IMAGE_VIDEO: SharedLlmModality[] = ["chat", "image", "video"];

export function getSupportedLlmModalitiesForProvider(
  provider: string,
): SharedLlmModality[] {
  if (provider === "minimax") return CHAT_IMAGE_VIDEO;
  if (provider === "custom" || provider === "openai") return CHAT_IMAGE;
  return CHAT_ONLY;
}

export function supportsLlmProviderModality(
  provider: string,
  modality: string,
): boolean {
  return getSupportedLlmModalitiesForProvider(provider).includes(
    modality as SharedLlmModality,
  );
}

export function coerceLlmProviderModality(
  provider: string,
  modality: SharedLlmModality,
): SharedLlmModality {
  return supportsLlmProviderModality(provider, modality) ? modality : "chat";
}

export function isImageGenerationModelId(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  if (!normalized) return false;
  const lastSegment = normalized.split(/[/:]/).filter(Boolean).at(-1) ?? "";
  return (
    /^gpt-image(?:-|$)/.test(lastSegment) || /^dall-e(?:-|$)/.test(lastSegment)
  );
}
