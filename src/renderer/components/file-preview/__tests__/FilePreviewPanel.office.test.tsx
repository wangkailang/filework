import { parseHTML } from "linkedom";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FilePreviewPanel } from "../FilePreviewPanel";

vi.mock("../../../i18n/i18n-react", () => {
  const LL = {
    code_loading: () => "Loading code",
    preview_files: () => "files",
    preview_loading: () => "Loading file...",
    preview_openInBrowser: () => "Open in browser",
    preview_readFileError: () => "Failed to read file",
    preview_readImageError: () => "Failed to read image",
    preview_truncated: (size: string) => `Truncated ${size}`,
    preview_emptyOfficeContent: () => "No extracted Office content",
    preview_emptySheet: () => "Empty sheet",
    preview_officePdfUnavailable: () => "Full PDF preview unavailable",
    preview_slide: (index: number) => `Slide ${index}`,
    preview_speakerNotes: () => "Speaker notes",
    preview_unsupported: () => "Preview not supported for",
    preview_unsupportedType: () => "this type",
    preview_viewRendered: () => "Preview",
    preview_viewSource: () => "Source",
    preview_viewContent: () => "Content",
    preview_viewVisual: () => "Visual",
    preview_zoomIn: () => "Zoom in",
    preview_zoomOut: () => "Zoom out",
  };

  return {
    useI18nContext: () => ({ LL }),
  };
});

vi.mock("../PdfViewer", () => ({
  PdfViewer: ({ filePath }: { filePath: string }) => (
    <div data-pdf-viewer-path={filePath} />
  ),
}));

vi.mock("../../ai-elements/message", () => ({
  MessageResponse: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
}));

describe("FilePreviewPanel Office preview", () => {
  let root: Root | null = null;
  let container: HTMLElement;
  let prepareOfficePreview: ReturnType<typeof vi.fn>;
  let consoleError: ReturnType<typeof vi.spyOn>;

  const flushPreview = async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await new Promise<void>((resolve) => setImmediate(resolve));
    act(() => {});
  };

  beforeEach(() => {
    const parsed = parseHTML('<div id="root"></div>');
    const document = parsed.document;
    const window = parsed.window;
    const originalError = console.error;
    consoleError = vi
      .spyOn(console, "error")
      .mockImplementation((message, ...args) => {
        if (
          typeof message === "string" &&
          message.includes("not wrapped in act")
        ) {
          return;
        }
        originalError(message, ...args);
      });
    const previewResult = {
      cacheHit: false,
      cacheKey: "cache-key",
      converterVersion: "LibreOffice 24.2",
      pdfPath: "/tmp/filework-preview/preview.pdf",
      previewKind: "pdf",
      previewPath: "/tmp/filework-preview/preview.pdf",
      sourceMtimeMs: 1,
      sourceSize: 10,
      thumbnailPath: "/tmp/filework-preview/thumbnail.png",
    };
    prepareOfficePreview = vi.fn().mockResolvedValue(previewResult);
    Object.assign(window, {
      filework: {
        prepareOfficePreview,
        readFilePreview: vi.fn(),
      },
    });
    vi.stubGlobal("window", window);
    vi.stubGlobal("document", document);
    vi.stubGlobal("HTMLElement", window.HTMLElement);
    vi.stubGlobal("navigator", window.navigator);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.getElementById("root") as HTMLElement;
    root = createRoot(container);
  });

  afterEach(async () => {
    if (root) {
      act(() => root?.unmount());
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    consoleError.mockRestore();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    root = null;
  });

  it("prepares Office files as cached PDFs and renders them with the PDF viewer", async () => {
    act(() => {
      root?.render(<FilePreviewPanel filePath="/workspace/report.docx" />);
    });

    expect(prepareOfficePreview).toHaveBeenCalledWith("/workspace/report.docx");
    await flushPreview();

    expect(container.innerHTML).toContain(
      'data-pdf-viewer-path="/tmp/filework-preview/preview.pdf"',
    );
    expect(container.textContent).not.toContain("Preview not supported");
  });

  it("renders Quick Look image previews when Office PDF conversion is unavailable", async () => {
    prepareOfficePreview.mockResolvedValue({
      cacheHit: false,
      cacheKey: "quick-look-cache-key",
      converterVersion: "Quick Look thumbnail",
      pdfPath: undefined,
      previewKind: "image",
      previewPath: "/tmp/filework-preview/thumbnail.png",
      sourceMtimeMs: 1,
      sourceSize: 10,
      thumbnailPath: "/tmp/filework-preview/thumbnail.png",
    });

    act(() => {
      root?.render(<FilePreviewPanel filePath="/workspace/deck.pptx" />);
    });

    await flushPreview();

    expect(container.innerHTML).toContain(
      "local-file://open?path=%2Ftmp%2Ffilework-preview%2Fthumbnail.png",
    );
    expect(container.innerHTML).not.toContain("data-pdf-viewer-path");
    expect(container.textContent).not.toContain("Failed to read file");
  });

  it("renders all extracted PPTX slides when only a Quick Look thumbnail is available", async () => {
    prepareOfficePreview.mockResolvedValue({
      cacheHit: false,
      cacheKey: "quick-look-cache-key",
      contentPreview: {
        kind: "presentation",
        slideCount: 2,
        slides: [
          { index: 1, notes: null, text: "Roadmap\nFirst milestone" },
          { index: 2, notes: "Speaker note", text: "Launch & Learn" },
        ],
      },
      converterVersion: "Quick Look thumbnail",
      pdfPath: undefined,
      previewKind: "image",
      previewPath: "/tmp/filework-preview/thumbnail.png",
      sourceMtimeMs: 1,
      sourceSize: 10,
      thumbnailPath: "/tmp/filework-preview/thumbnail.png",
      visualPreviewUnavailable: true,
    });

    act(() => {
      root?.render(<FilePreviewPanel filePath="/workspace/deck.pptx" />);
    });

    await flushPreview();

    expect(container.innerHTML).toContain('data-office-slide="1"');
    expect(container.innerHTML).toContain('data-office-slide="2"');
    expect(container.textContent).toContain("Roadmap");
    expect(container.textContent).toContain("First milestone");
    expect(container.textContent).toContain("Launch & Learn");
    expect(container.textContent).toContain("Speaker note");
    expect(container.textContent).toContain("Full PDF preview unavailable");
  });

  it("renders every Excel sheet and switches between sheet tabs", async () => {
    prepareOfficePreview.mockResolvedValueOnce({
      cacheHit: false,
      cacheKey: "content-cache-key",
      contentPreview: {
        kind: "spreadsheet",
        sheetCount: 2,
        sheets: [
          {
            columnCount: 2,
            name: "North",
            range: "A1:B2",
            rowCount: 2,
            rows: [
              ["Name", "Score"],
              ["Ada", "42"],
            ],
            truncated: false,
          },
          {
            columnCount: 2,
            name: "South",
            range: "A1:B2",
            rowCount: 2,
            rows: [
              ["Name", "Score"],
              ["Lin", "37"],
            ],
            truncated: false,
          },
        ],
      },
      converterVersion: "Content extraction",
      pdfPath: undefined,
      previewKind: "content",
      previewPath: "/tmp/filework-preview/content.json",
      sourceMtimeMs: 1,
      sourceSize: 10,
      thumbnailPath: undefined,
      visualPreviewUnavailable: true,
    });

    act(() => {
      root?.render(<FilePreviewPanel filePath="/workspace/metrics.xlsx" />);
    });

    await flushPreview();

    expect(container.innerHTML).toContain('data-office-sheet-tab="North"');
    expect(container.innerHTML).toContain('data-office-sheet-tab="South"');
    expect(container.textContent).toContain("Ada");
    expect(container.textContent).not.toContain("Lin");

    const south = container.querySelector(
      '[data-office-sheet-tab="South"]',
    ) as HTMLElement;
    act(() => {
      south.click();
    });

    expect(container.textContent).toContain("Lin");
    expect(container.textContent).not.toContain("Ada");
  });
});
