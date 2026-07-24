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
    preview_selectPptxElement: () => "Select a slide element",
    preview_selectedPptxElement: () => "Selected",
    preview_truncated: (size: string) => `Truncated ${size}`,
    preview_emptyOfficeContent: () => "No extracted Office content",
    preview_emptySheet: () => "Empty sheet",
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
  let readFile: ReturnType<typeof vi.fn>;
  let consoleError: ReturnType<typeof vi.spyOn>;

  const flushPreview = async () => {
    for (let index = 0; index < 3; index++) {
      await Promise.resolve();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
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
      contentPreview: {
        kind: "document",
        source: "mammoth",
        text: "Project brief",
      },
      previewKind: "content",
      sourceMtimeMs: 1,
      sourceSize: 10,
    };
    prepareOfficePreview = vi.fn().mockResolvedValue(previewResult);
    readFile = vi.fn((path: string) =>
      Promise.resolve(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 60">
          <g data-ooxml-shape-idx="${path.includes("slide-2") ? "7" : "3"}" data-ooxml-shape-type="autoshape">
            <rect width="100" height="60" />
            <text>
              <tspan data-ooxml-para-idx="0">
                <tspan data-ooxml-run-idx="0">${path.includes("slide-2") ? "Launch &amp; Learn" : "Roadmap"}</tspan>
              </tspan>
            </text>
          </g>
        </svg>`,
      ),
    );
    Object.assign(window, {
      filework: {
        prepareOfficePreview,
        readFile,
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

  it("renders non-presentation Office files from local structured content", async () => {
    act(() => {
      root?.render(<FilePreviewPanel filePath="/workspace/report.docx" />);
    });

    expect(prepareOfficePreview).toHaveBeenCalledWith("/workspace/report.docx");
    await flushPreview();

    expect(container.textContent).toContain("Project brief");
    expect(container.innerHTML).not.toContain("data-pdf-viewer-path");
    expect(container.textContent).not.toContain("Preview not supported");
  });

  it("renders selectable inline PPTX slides and publishes the selected text object", async () => {
    prepareOfficePreview.mockResolvedValue({
      cacheHit: false,
      cacheKey: "presentation-cache-key",
      contentPreview: {
        kind: "presentation",
        slideCount: 2,
        slides: [
          {
            hidden: false,
            index: 1,
            notes: null,
            previewPath: "/tmp/filework-preview/slide-1.svg",
            text: "Roadmap\nFirst milestone",
          },
          {
            hidden: false,
            index: 2,
            notes: "Speaker note",
            previewPath: "/tmp/filework-preview/slide-2.svg",
            text: "Launch & Learn",
          },
        ],
      },
      previewKind: "presentation",
      sourceMtimeMs: 1,
      sourceSize: 10,
    });

    act(() => {
      root?.render(<FilePreviewPanel filePath="/workspace/deck.pptx" />);
    });

    await flushPreview();

    expect(container.innerHTML).toContain('data-presentation-slide="1"');
    expect(container.innerHTML).toContain('data-presentation-slide="2"');
    expect(container.innerHTML).toContain(
      'data-presentation-object-id="slide:1/shape:3"',
    );
    expect(container.innerHTML).toContain(
      'data-presentation-text-object-id="slide:2/shape:7/text:0:0"',
    );
    expect(container.innerHTML).not.toContain("data-pdf-viewer-path");
    expect(container.textContent).not.toContain("Full PDF preview unavailable");

    let selected:
      | {
          objectId?: string;
          sourcePath?: string;
          sourceRevision?: string;
        }
      | undefined;
    window.addEventListener("filework:pptx-selection", (event) => {
      selected = (
        event as CustomEvent<{
          objectId?: string;
          sourcePath?: string;
          sourceRevision?: string;
        }>
      ).detail;
    });
    const run = container.querySelector(
      '[data-presentation-text-object-id="slide:2/shape:7/text:0:0"]',
    ) as HTMLElement;
    act(() => {
      run.dispatchEvent(new window.Event("click", { bubbles: true }));
    });

    expect(selected).toMatchObject({
      objectId: "slide:2/shape:7/text:0:0",
      sourcePath: "/workspace/deck.pptx",
      sourceRevision: "presentation-cache-key",
    });
    expect(
      container
        .querySelector('[data-presentation-object-id="slide:2/shape:7"]')
        ?.getAttribute("data-presentation-selected"),
    ).toBe("true");
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
      previewKind: "content",
      sourceMtimeMs: 1,
      sourceSize: 10,
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
