import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  realpath,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { extname, join } from "node:path";
import { promisify } from "node:util";
import mammoth from "mammoth";
import * as XLSX from "xlsx";
import type {
  OfficeContentPreview,
  OfficeDocumentContentPreview,
  OfficePresentationContentPreview,
  OfficeSpreadsheetContentPreview,
} from "../../shared/office-preview";
import {
  extractSlideText,
  listSlideAndNotesPaths,
  parsePptxMetaXml,
} from "../skills/pptx-processor";

const CONTENT_PREVIEW_CACHE_VERSION = "office-content-preview-v2";
const DEFAULT_TEXTUTIL_TIMEOUT_MS = 15_000;
const TEXTUTIL_MAX_BUFFER = 20 * 1024 * 1024;

const SPREADSHEET_EXTENSIONS = new Set([
  ".xls",
  ".xlsx",
  ".xlsm",
  ".xlt",
  ".xltx",
  ".xltm",
  ".ods",
]);

const PRESENTATION_OOXML_EXTENSIONS = new Set([
  ".pptx",
  ".pptm",
  ".potx",
  ".potm",
]);

const LEGACY_PRESENTATION_EXTENSIONS = new Set([".ppt", ".pot", ".pps"]);

const DOCUMENT_OOXML_EXTENSIONS = new Set([".docx", ".docm", ".dotx", ".dotm"]);

const TEXTUTIL_DOCUMENT_EXTENSIONS = new Set([".doc", ".dot", ".odt", ".rtf"]);

const execFileAsync = promisify(execFile);
const requireFromHere = createRequire(import.meta.url);

type JSZipFile = { async: (kind: "string") => Promise<string> };
type JSZipArchive = {
  file: (path: string) => JSZipFile | null;
  files: Record<string, unknown>;
};
type JSZipModule = {
  loadAsync: (buf: Buffer) => Promise<JSZipArchive>;
};

interface OfficeContentPreviewOptions {
  cacheRoot: string;
  textutilPath?: string;
  textutilTimeoutMs?: number;
}

interface OfficeContentFingerprint {
  cacheKey: string;
  sourcePath: string;
  sourceMtimeMs: number;
  sourceSize: number;
  extension: string;
}

interface CachedOfficeContentPreview {
  version: string;
  preview: OfficeContentPreview;
}

export interface OfficeContentPreviewResult {
  cacheKey: string;
  cacheHit: boolean;
  contentPreviewPath: string;
  preview: OfficeContentPreview;
  sourceMtimeMs: number;
  sourceSize: number;
}

const loadJSZip = (): JSZipModule => {
  const mammothRequire = createRequire(requireFromHere.resolve("mammoth"));
  return mammothRequire("jszip") as JSZipModule;
};

const asErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const unsupportedPreview = (
  reason: "unsupported-format" | "parse-error",
  message: string,
): OfficeContentPreview => ({
  kind: "unsupported",
  reason,
  message,
});

const buildContentFingerprint = async (
  sourcePath: string,
): Promise<OfficeContentFingerprint> => {
  const resolvedPath = await realpath(sourcePath);
  const stats = await stat(resolvedPath);
  const extension = extname(resolvedPath).toLowerCase();
  const hash = createHash("sha256")
    .update(CONTENT_PREVIEW_CACHE_VERSION)
    .update("\0")
    .update(resolvedPath)
    .update("\0")
    .update(extension)
    .update("\0")
    .update(String(stats.mtimeMs))
    .update("\0")
    .update(String(stats.size))
    .digest("hex")
    .slice(0, 40);
  return {
    cacheKey: hash,
    sourcePath: resolvedPath,
    sourceMtimeMs: stats.mtimeMs,
    sourceSize: stats.size,
    extension,
  };
};

const readCachedPreview = async (
  contentPreviewPath: string,
): Promise<OfficeContentPreview | null> => {
  try {
    const parsed = JSON.parse(
      await readFile(contentPreviewPath, "utf8"),
    ) as CachedOfficeContentPreview;
    if (parsed.version !== CONTENT_PREVIEW_CACHE_VERSION) return null;
    if (!parsed.preview || typeof parsed.preview !== "object") return null;
    return parsed.preview;
  } catch {
    return null;
  }
};

const writeCachedPreview = async (
  contentPreviewPath: string,
  preview: OfficeContentPreview,
) => {
  const tempPath = `${contentPreviewPath}.${process.pid}.tmp`;
  await writeFile(
    tempPath,
    JSON.stringify(
      {
        version: CONTENT_PREVIEW_CACHE_VERSION,
        preview,
      } satisfies CachedOfficeContentPreview,
      null,
      2,
    ),
    "utf8",
  );
  await rename(tempPath, contentPreviewPath);
};

const mammothMessages = (messages: unknown[] | undefined): string[] =>
  (messages ?? [])
    .map((message) => {
      if (
        message &&
        typeof message === "object" &&
        "message" in message &&
        typeof (message as { message?: unknown }).message === "string"
      ) {
        return (message as { message: string }).message;
      }
      return String(message);
    })
    .filter((message) => message.trim().length > 0);

const sanitizeOfficeHtml = (html: string): string =>
  html
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<iframe\b[\s\S]*?<\/iframe>/gi, "")
    .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, "");

const htmlToText = (html: string): string =>
  html
    .replace(/<style\b[\s\S]*?<\/style>/gi, "")
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

const readDocxPreview = async (
  sourcePath: string,
): Promise<OfficeDocumentContentPreview> => {
  const [htmlResult, textResult] = await Promise.all([
    mammoth.convertToHtml({ path: sourcePath }),
    mammoth.extractRawText({ path: sourcePath }),
  ]);
  return {
    kind: "document",
    source: "mammoth",
    text: textResult.value.trim(),
    html: sanitizeOfficeHtml(htmlResult.value),
    warnings: [
      ...mammothMessages(htmlResult.messages),
      ...mammothMessages(textResult.messages),
    ],
  };
};

const resolveTextutilPath = (explicit?: string): string => {
  if (explicit?.trim()) return explicit;
  if (process.env.FILEWORK_TEXTUTIL_PATH?.trim()) {
    return process.env.FILEWORK_TEXTUTIL_PATH;
  }
  return "/usr/bin/textutil";
};

const readTextutilDocumentPreview = async (
  sourcePath: string,
  options: OfficeContentPreviewOptions,
): Promise<OfficeDocumentContentPreview> => {
  const textutil = resolveTextutilPath(options.textutilPath);
  const { stdout } = await execFileAsync(
    textutil,
    ["-convert", "html", "-stdout", "--", sourcePath],
    {
      encoding: "utf8",
      maxBuffer: TEXTUTIL_MAX_BUFFER,
      timeout: options.textutilTimeoutMs ?? DEFAULT_TEXTUTIL_TIMEOUT_MS,
    },
  );
  const html = sanitizeOfficeHtml(stdout);
  return {
    kind: "document",
    source: "textutil",
    text: htmlToText(html),
    html,
  };
};

const readDocumentPreview = async (
  fingerprint: OfficeContentFingerprint,
  options: OfficeContentPreviewOptions,
): Promise<OfficeContentPreview> => {
  if (DOCUMENT_OOXML_EXTENSIONS.has(fingerprint.extension)) {
    try {
      return await readDocxPreview(fingerprint.sourcePath);
    } catch (docxError) {
      try {
        return await readTextutilDocumentPreview(
          fingerprint.sourcePath,
          options,
        );
      } catch (textutilError) {
        return unsupportedPreview(
          "parse-error",
          `Word content preview failed: ${asErrorMessage(
            docxError,
          )}; textutil fallback failed: ${asErrorMessage(textutilError)}`,
        );
      }
    }
  }

  try {
    return await readTextutilDocumentPreview(fingerprint.sourcePath, options);
  } catch (error) {
    return unsupportedPreview(
      "parse-error",
      `Word content preview failed: ${asErrorMessage(error)}`,
    );
  }
};

const readArchive = async (sourcePath: string): Promise<JSZipArchive> => {
  const buffer = await readFile(sourcePath);
  return await loadJSZip().loadAsync(buffer);
};

const readPresentationPreview = async (
  sourcePath: string,
): Promise<OfficePresentationContentPreview> => {
  const archive = await readArchive(sourcePath);
  const entries = listSlideAndNotesPaths(Object.keys(archive.files));
  const slides = [];
  for (const { slidePath, notesPath, index } of entries) {
    const slideFile = archive.file(slidePath);
    if (!slideFile) continue;
    const slideXml = await slideFile.async("string");
    const text = extractSlideText(slideXml);
    let notes: string | null = null;
    if (notesPath) {
      const notesFile = archive.file(notesPath);
      if (notesFile) {
        const notesText = extractSlideText(await notesFile.async("string"));
        notes = notesText || null;
      }
    }
    slides.push({ index, text, notes });
  }

  const coreFile = archive.file("docProps/core.xml");
  const appFile = archive.file("docProps/app.xml");
  const meta = parsePptxMetaXml(
    coreFile ? await coreFile.async("string") : null,
    appFile ? await appFile.async("string") : null,
  );

  return {
    kind: "presentation",
    slideCount: meta.slideCount ?? slides.length,
    slides,
  };
};

const normalizeCellValue = (value: unknown): string => {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }
  return JSON.stringify(value);
};

const readSpreadsheetPreview = (
  sourcePath: string,
): OfficeSpreadsheetContentPreview => {
  const workbook = XLSX.readFile(sourcePath, {
    cellDates: true,
  });
  const sheets = workbook.SheetNames.map((name) => {
    const sheet = workbook.Sheets[name];
    const rawRows = XLSX.utils.sheet_to_json(sheet, {
      blankrows: false,
      defval: "",
      header: 1,
      raw: false,
    }) as unknown[][];
    const range = sheet["!ref"];
    const decodedRange = range ? XLSX.utils.decode_range(range) : null;
    const rowCount = decodedRange ? decodedRange.e.r + 1 : rawRows.length;
    const columnCount = decodedRange
      ? decodedRange.e.c + 1
      : rawRows.reduce((max, row) => Math.max(max, row.length), 0);
    const rows = rawRows.map((row) => row.map(normalizeCellValue));

    return {
      name,
      rows,
      rowCount,
      columnCount,
      range,
      truncated: false,
    };
  });

  return {
    kind: "spreadsheet",
    sheetCount: workbook.SheetNames.length,
    sheets,
  };
};

const generateContentPreview = async (
  fingerprint: OfficeContentFingerprint,
  options: OfficeContentPreviewOptions,
): Promise<OfficeContentPreview> => {
  if (SPREADSHEET_EXTENSIONS.has(fingerprint.extension)) {
    try {
      return readSpreadsheetPreview(fingerprint.sourcePath);
    } catch (error) {
      return unsupportedPreview(
        "parse-error",
        `Spreadsheet content preview failed: ${asErrorMessage(error)}`,
      );
    }
  }

  if (PRESENTATION_OOXML_EXTENSIONS.has(fingerprint.extension)) {
    try {
      return await readPresentationPreview(fingerprint.sourcePath);
    } catch (error) {
      return unsupportedPreview(
        "parse-error",
        `PowerPoint content preview failed: ${asErrorMessage(error)}`,
      );
    }
  }

  if (LEGACY_PRESENTATION_EXTENSIONS.has(fingerprint.extension)) {
    return unsupportedPreview(
      "unsupported-format",
      "Legacy PowerPoint files are not supported; save the deck as .pptx.",
    );
  }

  if (
    DOCUMENT_OOXML_EXTENSIONS.has(fingerprint.extension) ||
    TEXTUTIL_DOCUMENT_EXTENSIONS.has(fingerprint.extension)
  ) {
    return await readDocumentPreview(fingerprint, options);
  }

  return unsupportedPreview(
    "unsupported-format",
    "This Office format does not have a local structured preview.",
  );
};

export const prepareOfficeContentPreview = async (
  sourcePath: string,
  options: OfficeContentPreviewOptions,
): Promise<OfficeContentPreviewResult> => {
  const fingerprint = await buildContentFingerprint(sourcePath);
  const cacheDir = join(options.cacheRoot, fingerprint.cacheKey);
  const contentPreviewPath = join(cacheDir, "content-preview.json");
  await mkdir(cacheDir, { recursive: true });

  const cached = await readCachedPreview(contentPreviewPath);
  if (cached) {
    return {
      cacheKey: fingerprint.cacheKey,
      cacheHit: true,
      contentPreviewPath,
      preview: cached,
      sourceMtimeMs: fingerprint.sourceMtimeMs,
      sourceSize: fingerprint.sourceSize,
    };
  }

  const preview = await generateContentPreview(fingerprint, options);
  await writeCachedPreview(contentPreviewPath, preview);
  return {
    cacheKey: fingerprint.cacheKey,
    cacheHit: false,
    contentPreviewPath,
    preview,
    sourceMtimeMs: fingerprint.sourceMtimeMs,
    sourceSize: fingerprint.sourceSize,
  };
};
