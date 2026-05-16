/**
 * Shared on-disk layout + download helper for generated media.
 *
 * Phase 2 image and Phase 3 video both produce files under
 * `~/.filework/generated/{sessionId}/{timestamp}-{shortId}.{ext}` after
 * downloading a short-lived CDN URL returned by the upstream provider.
 * Two callers were doing the same dance, including a private `tsSlug()`
 * each — consolidate here so adding a new modality is a single import.
 */

import crypto from "node:crypto";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join } from "node:path";

const GENERATED_ROOT = join(homedir(), ".filework", "generated");
const ATTACHMENTS_ROOT = join(homedir(), ".filework", "attachments");

/** Public for path-validation in protocol handlers. */
export const generatedRoot = (): string => GENERATED_ROOT;

/** Public for path-validation in protocol handlers. */
export const attachmentsRoot = (): string => ATTACHMENTS_ROOT;

/** Filesystem-safe ISO timestamp: `YYYYMMDDTHHMMSSZ`. */
export const tsSlug = (): string =>
  new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");

export interface SavedMedia {
  /** Absolute path written. */
  path: string;
  /** 8-char random hex paired with the timestamp; safe for use as a React key. */
  shortId: string;
}

/**
 * Download a media URL and persist it under
 * `~/.filework/generated/{sessionId}/{ts}-{shortId}.{ext}`.
 *
 * Throws on HTTP error so the caller can surface it via the IPC error
 * channel. Uses the injected fetch so split-routing proxy rules apply.
 */
export const saveMediaToDisk = async (
  fetchFn: typeof fetch,
  url: string,
  sessionId: string,
  ext: string,
): Promise<SavedMedia> => {
  const resp = await fetchFn(url);
  if (!resp.ok) {
    throw new Error(`download HTTP ${resp.status}`);
  }
  const bytes = new Uint8Array(await resp.arrayBuffer());
  const shortId = crypto.randomBytes(4).toString("hex");
  const dir = join(GENERATED_ROOT, sessionId || "default");
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${tsSlug()}-${shortId}.${ext}`);
  await writeFile(path, bytes);
  return { path, shortId };
};

export interface SavedAttachment {
  /** Absolute path written under `~/.filework/attachments/{sessionId}/`. */
  path: string;
  /** 8-char hex; doubles as React key. */
  shortId: string;
}

/**
 * Copy a user-picked / dropped file into
 * `~/.filework/attachments/{sessionId}/{ts}-{shortId}.{ext}`.
 *
 * Uses `fs.copyFile` rather than read→write so multi-megabyte PDFs don't
 * load into memory. Preserves the source extension so the renderer's
 * `local-file://` protocol handler can pick a MIME from the suffix.
 */
export const saveAttachmentToDisk = async (
  sourcePath: string,
  sessionId: string,
): Promise<SavedAttachment> => {
  const ext = extname(sourcePath).replace(/^\./, "").toLowerCase() || "bin";
  const shortId = crypto.randomBytes(4).toString("hex");
  const dir = join(ATTACHMENTS_ROOT, sessionId || "default");
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${tsSlug()}-${shortId}.${ext}`);
  await copyFile(sourcePath, path);
  return { path, shortId };
};
