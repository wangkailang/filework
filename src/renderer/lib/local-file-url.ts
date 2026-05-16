/**
 * Build a `local-file://` URL for an absolute filesystem path. Served by
 * the custom protocol registered in `src/main/index.ts` — used by image
 * thumbnails, PDF/video viewers, and attachment chips.
 *
 * URL-encodes the path so spaces and special chars round-trip safely
 * through the protocol handler's `URL.searchParams.get("path")`.
 */
export const localFileUrl = (absolutePath: string): string =>
  `local-file://open?path=${encodeURIComponent(absolutePath)}`;
