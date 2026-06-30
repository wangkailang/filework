import { parseHTML } from "linkedom";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FilePreviewPanel } from "../FilePreviewPanel";

vi.mock("../../../i18n/i18n-react", () => ({
  useI18nContext: () => ({
    LL: {
      code_loading: () => "Loading code",
      preview_files: () => "files",
      preview_loading: () => "Loading file...",
      preview_openInBrowser: () => "Open in browser",
      preview_readFileError: () => "Failed to read file",
      preview_readImageError: () => "Failed to read image",
      preview_truncated: (size: string) => `Truncated ${size}`,
      preview_unsupported: () => "Preview not supported for",
      preview_unsupportedType: () => "this type",
      preview_viewRendered: () => "Preview",
      preview_viewSource: () => "Source",
      preview_zoomIn: () => "Zoom in",
      preview_zoomOut: () => "Zoom out",
    },
  }),
}));

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
});
