/**
 * User-attachment → ModelMessage content adapter.
 *
 * The chat composer attaches files as `AttachmentPart` entries on the
 * user message. The message converter walks them here to build the
 * provider-shaped content array that the Vercel AI SDK forwards to the
 * model.
 *
 * Provider capability matters: Anthropic's `claude` family accepts
 * native `file` content (used for PDFs); OpenAI and DeepSeek only
 * accept `image` content for vision; MiniMax chat accepts images;
 * Ollama is text-only. Anything outside the matrix falls back to a
 * text notice so the model can still acknowledge the attachment
 * exists but doesn't see broken / unsupported content.
 *
 * Known gap: token estimation in `truncate-to-fit.ts` does not yet
 * count image bytes. Large image attachments will under-report.
 * Acceptable for now — track usage via the post-stream usage event.
 */

import { readFile } from "node:fs/promises";

import type { AttachmentKind } from "../core/session/message-parts";

export interface AttachmentHistoryEntry {
  type: "attachment";
  path: string;
  name: string;
  mimeType: string;
  size: number;
  kind: AttachmentKind;
}

export type UserContentPart =
  | { type: "text"; text: string }
  | { type: "image"; image: Uint8Array; mediaType: string }
  | { type: "file"; data: Uint8Array; mediaType: string };

interface ProviderCaps {
  image: boolean;
  pdf: boolean;
}

/**
 * Static capability matrix. Conservative: if a provider isn't listed
 * we default to image-only (covers most OpenAI-compatible vision
 * endpoints) — text always works.
 */
const PROVIDER_CAPS: Record<string, ProviderCaps> = {
  anthropic: { image: true, pdf: true },
  openai: { image: true, pdf: false },
  deepseek: { image: true, pdf: false },
  minimax: { image: true, pdf: false },
  ollama: { image: false, pdf: false },
  custom: { image: true, pdf: false },
};

const DEFAULT_CAPS: ProviderCaps = { image: true, pdf: false };
const TEXT_MAX_BYTES = 200 * 1024; // 200 KB inline cap per file

const capsForProvider = (providerId?: string): ProviderCaps => {
  if (!providerId) return DEFAULT_CAPS;
  return PROVIDER_CAPS[providerId] ?? DEFAULT_CAPS;
};

/**
 * Build the user-message content array given the typed text and any
 * attached files. Reads each file from disk; on failure / unsupported,
 * appends a text notice rather than throwing so a single bad attachment
 * never blocks the whole submit.
 */
export async function buildUserContentWithAttachments(
  baseText: string,
  attachments: AttachmentHistoryEntry[],
  providerId?: string,
): Promise<UserContentPart[]> {
  const caps = capsForProvider(providerId);
  const out: UserContentPart[] = [];
  const notices: string[] = [];

  if (baseText) out.push({ type: "text", text: baseText });

  // Read all supported-and-eligible attachments in parallel — disk reads
  // are independent and N×serial latency adds up fast on a multi-PDF
  // submit. Each Promise resolves to a part-or-notice tuple so we can
  // preserve input order in the output pass.
  type Resolved = { part: UserContentPart } | { notice: string };
  const reads: Promise<Resolved>[] = attachments.map(async (a) => {
    try {
      if (a.kind === "image") {
        if (!caps.image) {
          return {
            notice: `[Attachment "${a.name}" was not sent: provider "${providerId ?? "unknown"}" does not support images.]`,
          };
        }
        const buf = await readFile(a.path);
        // Node's Buffer is already a Uint8Array — no copy.
        return {
          part: {
            type: "image" as const,
            image: buf,
            mediaType: a.mimeType || "image/png",
          },
        };
      }
      if (a.kind === "pdf") {
        if (!caps.pdf) {
          return {
            notice: `[Attachment "${a.name}" (PDF) was not sent: provider "${providerId ?? "unknown"}" does not support PDF documents. Try Anthropic / Claude for native PDF support.]`,
          };
        }
        const buf = await readFile(a.path);
        return {
          part: {
            type: "file" as const,
            data: buf,
            mediaType: "application/pdf",
          },
        };
      }
      // text / code — inline. Cap per file so a stray 5MB log doesn't
      // blow the context window. TextDecoder is non-fatal so a multi-byte
      // codepoint split at the truncation boundary yields U+FFFD rather
      // than throwing.
      const buf = await readFile(a.path);
      const truncated = buf.byteLength > TEXT_MAX_BYTES;
      const slice = truncated ? buf.subarray(0, TEXT_MAX_BYTES) : buf;
      const text = new TextDecoder("utf-8", { fatal: false }).decode(slice);
      return {
        part: {
          type: "text" as const,
          text: `\n\n--- file: ${a.name} (${a.mimeType}) ---\n${text}${truncated ? "\n... [truncated]" : ""}\n--- end: ${a.name} ---\n`,
        },
      };
    } catch (err) {
      return {
        notice: `[Failed to read attachment "${a.name}": ${err instanceof Error ? err.message : String(err)}]`,
      };
    }
  });

  const resolved = await Promise.all(reads);
  for (const r of resolved) {
    if ("part" in r) out.push(r.part);
    else notices.push(r.notice);
  }

  if (notices.length > 0) {
    out.push({
      type: "text",
      text: `\n\n${notices.join("\n")}`,
    });
  }

  // Defensive: an empty content array is rejected by some provider
  // adapters even though `userModelMessageSchema` permits it. Fall back
  // to a single text part so the model gets *something* to act on.
  if (out.length === 0) {
    out.push({
      type: "text",
      text: "(attachment was provided but could not be processed)",
    });
  }

  return out;
}
