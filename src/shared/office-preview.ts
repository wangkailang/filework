export type OfficePreviewKind = "presentation" | "content";

export interface OfficeDocumentContentPreview {
  kind: "document";
  text: string;
  html?: string;
  warnings?: string[];
  source: "mammoth" | "textutil";
}

export interface OfficePresentationSlidePreview {
  index: number;
  text: string;
  notes: string | null;
  previewPath?: string;
  hidden?: boolean;
}

export interface OfficePresentationContentPreview {
  kind: "presentation";
  slideCount: number;
  slides: OfficePresentationSlidePreview[];
}

export interface OfficeSpreadsheetSheetPreview {
  name: string;
  rows: string[][];
  rowCount: number;
  columnCount: number;
  range?: string;
  truncated: boolean;
}

export interface OfficeSpreadsheetContentPreview {
  kind: "spreadsheet";
  sheetCount: number;
  sheets: OfficeSpreadsheetSheetPreview[];
}

export interface OfficeUnsupportedContentPreview {
  kind: "unsupported";
  reason: "unsupported-format" | "parse-error";
  message: string;
}

export type OfficeContentPreview =
  | OfficeDocumentContentPreview
  | OfficePresentationContentPreview
  | OfficeSpreadsheetContentPreview
  | OfficeUnsupportedContentPreview;

export interface OfficePreviewResult {
  cacheKey: string;
  previewKind: OfficePreviewKind;
  sourceMtimeMs: number;
  sourceSize: number;
  rendererVersion?: string;
  cacheHit: boolean;
  contentPreview?: OfficeContentPreview;
  contentPreviewPath?: string;
  contentPreviewError?: string;
}
