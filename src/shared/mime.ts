/**
 * Single source of truth for extension → MIME type mapping. Shared
 * between the `local-file://` protocol handler (which serves files to
 * the renderer) and the `chat:attachFile` IPC (which records the MIME
 * on the attachment metadata).
 *
 * Coverage is biased toward what users actually attach in chat
 * (screenshots, PDFs, code snippets). Unknowns fall back to
 * `application/octet-stream` for binary safety; well-known plain-text
 * extensions outside the explicit table degrade to `text/plain`.
 */

const MIME_BY_EXT: Record<string, string> = {
  // images
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  // documents
  pdf: "application/pdf",
  // video (used by local-file:// protocol for inline preview)
  mp4: "video/mp4",
  webm: "video/webm",
  ogg: "video/ogg",
  mov: "video/quicktime",
  m4v: "video/x-m4v",
  // text / code
  txt: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  json: "application/json",
  yaml: "application/yaml",
  yml: "application/yaml",
  toml: "application/toml",
  xml: "application/xml",
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  ts: "text/x-typescript",
  tsx: "text/x-typescript",
  js: "text/javascript",
  jsx: "text/javascript",
  py: "text/x-python",
  rs: "text/x-rust",
  go: "text/x-go",
  java: "text/x-java",
  kt: "text/x-kotlin",
  swift: "text/x-swift",
  c: "text/x-c",
  cpp: "text/x-c++",
  cc: "text/x-c++",
  h: "text/x-c",
  hpp: "text/x-c++",
  sh: "text/x-shellscript",
  bash: "text/x-shellscript",
  zsh: "text/x-shellscript",
  sql: "application/sql",
};

const TEXT_EXT_FALLBACK = new Set([
  "log",
  "csv",
  "tsv",
  "ini",
  "conf",
  "rb",
  "php",
  "lua",
  "r",
  "scala",
  "dart",
  "vue",
  "svelte",
  "graphql",
  "gql",
  "proto",
  "tf",
  "hcl",
  "dockerfile",
]);

/** Extensions accepted by the chat file picker — drives showOpenDialog filters. */
export const ATTACHMENT_PICKER_EXTENSIONS: readonly string[] = [
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "pdf",
  "txt",
  "md",
  "markdown",
  "json",
  "yaml",
  "yml",
  "toml",
  "xml",
  "html",
  "css",
  "ts",
  "tsx",
  "js",
  "jsx",
  "py",
  "rs",
  "go",
  "java",
  "kt",
  "swift",
  "c",
  "cpp",
  "h",
  "hpp",
  "sh",
  "sql",
];

const lowerExt = (filenameOrPath: string): string => {
  const dot = filenameOrPath.lastIndexOf(".");
  if (dot === -1 || dot === filenameOrPath.length - 1) return "";
  return filenameOrPath.slice(dot + 1).toLowerCase();
};

export const sniffMimeType = (filenameOrPath: string): string => {
  const ext = lowerExt(filenameOrPath);
  if (!ext) return "application/octet-stream";
  if (MIME_BY_EXT[ext]) return MIME_BY_EXT[ext];
  if (TEXT_EXT_FALLBACK.has(ext)) return "text/plain";
  return "application/octet-stream";
};

export type AttachmentKind = "image" | "pdf" | "text";

export const classifyKind = (mimeType: string): AttachmentKind => {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType === "application/pdf") return "pdf";
  return "text";
};
