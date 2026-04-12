import type { ChatMessage, MessagePart, TextPart } from "./types";

export const migrateToParts = (msg: ChatMessage): MessagePart[] => {
  if (msg.parts && msg.parts.length > 0) return msg.parts;
  const parts: MessagePart[] = [];
  if (msg.toolInvocations) {
    for (const inv of msg.toolInvocations) {
      parts.push({ type: "tool", ...inv });
    }
  }
  if (msg.content) {
    parts.push({ type: "text", text: msg.content });
  }
  return parts;
};

export const contentFromParts = (parts: MessagePart[]): string =>
  parts
    .filter((p): p is TextPart => p.type === "text")
    .map((p) => p.text)
    .join("");

export const truncateTitle = (text: string, max = 50): string =>
  text.length > max ? `${text.slice(0, max)}…` : text;
