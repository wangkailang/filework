import {
  Code2,
  Eye,
  FileText,
  FileWarning,
  Globe,
  Loader2,
  MousePointer2,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  OfficeContentPreview,
  OfficePresentationContentPreview,
} from "../../../shared/office-preview";
import { useI18nContext } from "../../i18n/i18n-react";
import { localFileUrl } from "../../lib/local-file-url";
import {
  PPTX_SELECTION_EVENT,
  type PptxObjectSelection,
  prepareInteractivePresentationSvg,
} from "../../lib/pptx-selection";
import { cn } from "../../lib/utils";
import {
  CodeViewer,
  getFileExtension,
  isSupportedFile,
} from "../ai-elements/code-viewer";
import { MessageResponse } from "../ai-elements/message";
import { AudioViewer } from "./AudioViewer";
import { PdfViewer } from "./PdfViewer";
import { VideoViewer } from "./VideoViewer";

const isPdfFile = (filename: string): boolean => {
  return getFileExtension(filename).toLowerCase() === ".pdf";
};

const OFFICE_EXTENSIONS = new Set([
  ".doc",
  ".docx",
  ".dot",
  ".dotx",
  ".docm",
  ".dotm",
  ".xls",
  ".xlsx",
  ".xlsm",
  ".xlt",
  ".xltx",
  ".xltm",
  ".ods",
  ".ppt",
  ".pptx",
  ".pptm",
  ".pot",
  ".potx",
  ".potm",
  ".odp",
]);

const isOfficeFile = (filename: string): boolean => {
  return OFFICE_EXTENSIONS.has(getFileExtension(filename).toLowerCase());
};

const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".bmp",
  ".webp",
  ".svg",
  ".ico",
  ".avif",
  ".tiff",
  ".tif",
]);

const isImageFile = (filename: string): boolean => {
  return IMAGE_EXTENSIONS.has(getFileExtension(filename).toLowerCase());
};

const VIDEO_EXTENSIONS = new Set([".mp4", ".webm", ".ogg", ".mov", ".m4v"]);

const isVideoFile = (filename: string): boolean => {
  return VIDEO_EXTENSIONS.has(getFileExtension(filename).toLowerCase());
};

// .ogg 容器既可是音视频,沿用现状归视频;.oga 明确为音频。
const AUDIO_EXTENSIONS = new Set([
  ".mp3",
  ".wav",
  ".flac",
  ".aac",
  ".m4a",
  ".opus",
  ".oga",
]);

const isAudioFile = (filename: string): boolean => {
  return AUDIO_EXTENSIONS.has(getFileExtension(filename).toLowerCase());
};

/** markdown 文件:支持"渲染预览 / 原文件源码"双模式切换。 */
const isMarkdownFile = (filename: string): boolean => {
  const e = getFileExtension(filename).toLowerCase();
  return e === ".md" || e === ".markdown";
};

/** html 文件:源码就地查看,另提供"在网页面板渲染为活页面"入口。 */
const isHtmlFile = (filename: string): boolean => {
  const e = getFileExtension(filename).toLowerCase();
  return e === ".html" || e === ".htm";
};

/** 人类可读的字节数(用于超大文件截断提示)。 */
const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(1)} ${units[i]}`;
};

type UsableOfficeContentPreview = Exclude<
  OfficeContentPreview,
  { kind: "unsupported" }
>;

const hasUsableOfficeContent = (
  preview: OfficeContentPreview | undefined,
): preview is UsableOfficeContentPreview =>
  Boolean(preview && preview.kind !== "unsupported");

interface OfficeContentLabels {
  emptyOfficeContent: string;
  emptySheet: string;
  selectElement: string;
  selectedElement: string;
  slide: (index: number) => string;
  speakerNotes: string;
}

const OfficeContentPreviewPane = ({
  preview,
  labels,
}: {
  preview: UsableOfficeContentPreview;
  labels: OfficeContentLabels;
}) => {
  const [sheetIndex, setSheetIndex] = useState(0);

  if (preview.kind === "document") {
    if (preview.html) {
      return (
        <iframe
          title="Office document content"
          sandbox=""
          srcDoc={`<!doctype html><html><head><meta charset="utf-8" /><style>body{font:14px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;line-height:1.55;margin:24px;color:#1f2937;}table{border-collapse:collapse;}td,th{border:1px solid #d1d5db;padding:4px 6px;}img{max-width:100%;}</style></head><body>${preview.html}</body></html>`}
          className="h-full w-full border-0 bg-background"
        />
      );
    }
    return (
      <pre className="h-full overflow-auto whitespace-pre-wrap px-6 py-4 text-sm leading-6 text-foreground">
        {preview.text || labels.emptyOfficeContent}
      </pre>
    );
  }

  if (preview.kind === "presentation") {
    if (preview.slides.length === 0) {
      return (
        <div className="flex h-full items-center justify-center px-6 text-sm text-muted-foreground">
          {labels.emptyOfficeContent}
        </div>
      );
    }
    return (
      <div
        className="h-full overflow-auto px-4 py-3"
        data-office-presentation-preview="true"
      >
        <div className="mx-auto flex max-w-3xl flex-col gap-3">
          {preview.slides.map((slide) => (
            <section
              key={slide.index}
              data-office-slide={slide.index}
              className="rounded-md border border-border bg-background px-4 py-3"
            >
              <div className="mb-2 text-xs font-medium uppercase text-muted-foreground">
                {labels.slide(slide.index)}
              </div>
              <div className="whitespace-pre-wrap text-sm leading-6 text-foreground">
                {slide.text || labels.emptyOfficeContent}
              </div>
              {slide.notes && (
                <div className="mt-3 border-t border-border pt-3">
                  <div className="mb-1 text-xs font-medium text-muted-foreground">
                    {labels.speakerNotes}
                  </div>
                  <div className="whitespace-pre-wrap text-sm leading-6 text-muted-foreground">
                    {slide.notes}
                  </div>
                </div>
              )}
            </section>
          ))}
        </div>
      </div>
    );
  }

  if (preview.sheets.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-sm text-muted-foreground">
        {labels.emptyOfficeContent}
      </div>
    );
  }

  const activeSheet =
    preview.sheets[Math.min(sheetIndex, preview.sheets.length - 1)];
  const [headerRow, ...bodyRows] = activeSheet.rows;
  const headerCells = (headerRow ?? []).map((cell, index) => ({
    id: `${activeSheet.name}-header-${index}`,
    value: cell,
  }));
  const bodyRowViews = bodyRows.map((row, rowIndex) => {
    const columns = headerRow ?? row;
    return {
      id: `${activeSheet.name}-row-${rowIndex}`,
      cells: columns.map((_, cellIndex) => ({
        id: `${activeSheet.name}-${rowIndex}-${cellIndex}`,
        value: row[cellIndex] ?? "",
      })),
    };
  });

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      data-office-spreadsheet-preview="true"
    >
      <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-border px-3 py-2">
        {preview.sheets.map((sheet, index) => (
          <button
            type="button"
            key={sheet.name}
            data-office-sheet-tab={sheet.name}
            aria-pressed={index === sheetIndex}
            onClick={() => setSheetIndex(index)}
            className={cn(
              "shrink-0 rounded-md px-2.5 py-1 text-xs transition-colors",
              index === sheetIndex
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
            )}
          >
            {sheet.name}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {activeSheet.rows.length === 0 ? (
          <div className="flex h-full items-center justify-center px-6 text-sm text-muted-foreground">
            {labels.emptySheet}
          </div>
        ) : (
          <table className="w-max min-w-full border-collapse text-sm">
            {headerRow && (
              <thead className="sticky top-0 bg-muted">
                <tr>
                  {headerCells.map((cell) => (
                    <th
                      key={cell.id}
                      scope="col"
                      className="border border-border px-3 py-2 text-left font-medium text-foreground"
                    >
                      {cell.value}
                    </th>
                  ))}
                </tr>
              </thead>
            )}
            <tbody>
              {bodyRowViews.map((row) => (
                <tr key={row.id}>
                  {row.cells.map((cell) => (
                    <td
                      key={cell.id}
                      className="border border-border px-3 py-1.5 text-foreground"
                    >
                      {cell.value}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
};

const OfficePresentationPreviewPane = ({
  labels,
  preview,
  sourcePath,
  sourceRevision,
  zoom,
}: {
  labels: OfficeContentLabels;
  preview: OfficePresentationContentPreview;
  sourcePath: string;
  sourceRevision: string;
  zoom: number;
}) => {
  const visualSlides = preview.slides.filter((slide) => slide.previewPath);
  const [selection, setSelection] = useState<PptxObjectSelection | null>(null);
  if (visualSlides.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-sm text-muted-foreground">
        {labels.emptyOfficeContent}
      </div>
    );
  }

  const selectObject = (nextSelection: PptxObjectSelection) => {
    setSelection(nextSelection);
    window.dispatchEvent(
      new window.CustomEvent(PPTX_SELECTION_EVENT, {
        detail: nextSelection,
      }),
    );
  };

  return (
    <div
      className="h-full overflow-auto bg-muted/40 px-4 py-4"
      data-office-presentation-visual="true"
    >
      <div
        className="sticky top-0 z-10 mx-auto mb-3 flex max-w-5xl items-center gap-2 rounded-md border border-border bg-background/95 px-3 py-2 text-xs text-muted-foreground shadow-sm backdrop-blur"
        data-presentation-selection-status="true"
      >
        <MousePointer2 className="size-3.5 shrink-0 text-primary" />
        {selection ? (
          <span className="min-w-0 truncate">
            {labels.selectedElement}: {labels.slide(selection.slideIndex)} ·{" "}
            {selection.objectType}
            {selection.text ? ` · ${selection.text}` : ""}
          </span>
        ) : (
          <span>{labels.selectElement}</span>
        )}
      </div>
      <div
        className="mx-auto flex max-w-5xl origin-top flex-col gap-5 transition-transform duration-150"
        style={{ transform: `scale(${zoom})` }}
      >
        {visualSlides.map((slide) => (
          <InteractivePresentationSlide
            key={slide.index}
            label={labels.slide(slide.index)}
            onSelect={selectObject}
            selectedObjectId={selection?.objectId ?? null}
            slide={slide}
            sourcePath={sourcePath}
            sourceRevision={sourceRevision}
          />
        ))}
      </div>
    </div>
  );
};

const InteractivePresentationSlide = ({
  label,
  onSelect,
  selectedObjectId,
  slide,
  sourcePath,
  sourceRevision,
}: {
  label: string;
  onSelect: (selection: PptxObjectSelection) => void;
  selectedObjectId: string | null;
  slide: OfficePresentationContentPreview["slides"][number];
  sourcePath: string;
  sourceRevision: string;
}) => {
  const containerRef = useRef<HTMLElement | null>(null);
  const [svg, setSvg] = useState<string | null>(null);
  const [inlineFailed, setInlineFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setSvg(null);
    setInlineFailed(false);
    if (!slide.previewPath) return;
    window.filework
      .readFile(slide.previewPath)
      .then((rawSvg) => {
        if (cancelled) return;
        const prepared = prepareInteractivePresentationSvg(
          String(rawSvg),
          slide.index,
        );
        if (!prepared) {
          setInlineFailed(true);
          return;
        }
        setSvg(prepared.svg);
      })
      .catch(() => {
        if (!cancelled) setInlineFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [slide.index, slide.previewPath]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    for (const shape of Array.from(
      container.querySelectorAll("[data-presentation-object-id]"),
    )) {
      const shapeId = shape.getAttribute("data-presentation-object-id");
      const isSelected = Boolean(
        selectedObjectId &&
          (selectedObjectId === shapeId ||
            selectedObjectId.startsWith(`${shapeId}/text:`)),
      );
      if (isSelected) {
        shape.setAttribute("data-presentation-selected", "true");
      } else {
        shape.removeAttribute("data-presentation-selected");
      }
    }
  }, [selectedObjectId]);

  const publishSelection = (target: EventTarget | null) => {
    if (!(target instanceof window.Element)) return;
    const textRun = target.closest("[data-presentation-text-object-id]");
    const shape = target.closest("[data-presentation-object-id]");
    if (!shape) return;
    const shapeIndex = Number(shape.getAttribute("data-ooxml-shape-idx"));
    const shapeObjectId = shape.getAttribute("data-presentation-object-id");
    const textObjectId = textRun?.getAttribute(
      "data-presentation-text-object-id",
    );
    if (!Number.isSafeInteger(shapeIndex) || !shapeObjectId) return;
    onSelect({
      editableText: Boolean(textObjectId),
      objectId: textObjectId ?? shapeObjectId,
      objectType:
        textObjectId !== null && textObjectId !== undefined
          ? "text"
          : (shape.getAttribute("data-ooxml-shape-type") ?? "shape"),
      shapeIndex,
      slideIndex: slide.index,
      sourcePath,
      sourceRevision,
      text: (textRun?.textContent ?? shape.textContent ?? "")
        .replace(/\s+/g, " ")
        .trim(),
    });
  };

  return (
    <figure
      data-presentation-slide={slide.index}
      className="overflow-hidden rounded-md border border-border bg-background shadow-sm"
    >
      <figcaption className="border-b border-border px-3 py-2 text-xs font-medium text-muted-foreground">
        {label}
      </figcaption>
      {svg ? (
        <section
          ref={containerRef}
          aria-label={label}
          className="presentation-slide-svg block h-auto w-full"
          onClick={(event) => {
            event.preventDefault();
            publishSelection(event.target);
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            publishSelection(event.target);
          }}
          // biome-ignore lint/security/noDangerouslySetInnerHtml: presentation SVG is parsed and sanitized before rendering.
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      ) : inlineFailed && slide.previewPath ? (
        <img
          src={localFileUrl(slide.previewPath)}
          alt={label}
          className="block h-auto w-full"
          draggable={false}
        />
      ) : (
        <div className="flex aspect-video items-center justify-center text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
        </div>
      )}
    </figure>
  );
};

interface FilePreviewPanelProps {
  filePath: string;
}

export const FilePreviewPanel = ({ filePath }: FilePreviewPanelProps) => {
  const { LL } = useI18nContext();
  const [content, setContent] = useState<string | null>(null);
  // 截断信息:超大文件只预览开头时,顶部提示条用。
  const [truncated, setTruncated] = useState(false);
  const [truncatedTotal, setTruncatedTotal] = useState(0);
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [officePreview, setOfficePreview] = useState<Awaited<
    ReturnType<typeof window.filework.prepareOfficePreview>
  > | null>(null);
  const [officeView, setOfficeView] = useState<"visual" | "content">("visual");
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [zoom, setZoom] = useState(1);
  // markdown 视图模式:rendered=渲染预览(默认),source=原文件源码(带行号)。
  const [mdView, setMdView] = useState<"rendered" | "source">("rendered");

  const fileName = filePath.split("/").pop() || filePath;
  const absolutePath = filePath;
  const ext = getFileExtension(fileName);
  const isPdf = isPdfFile(fileName);
  const isOffice = isOfficeFile(fileName);
  const isImage = isImageFile(fileName);
  const isVideo = isVideoFile(fileName);
  const isAudio = isAudioFile(fileName);
  const isMarkdown = isMarkdownFile(fileName);
  const isHtml = isHtmlFile(fileName);
  const supported =
    isSupportedFile(fileName) ||
    isPdf ||
    isOffice ||
    isImage ||
    isVideo ||
    isAudio;

  const zoomIn = useCallback(() => setZoom((z) => Math.min(z + 0.25, 5)), []);
  const zoomOut = useCallback(
    () => setZoom((z) => Math.max(z - 0.25, 0.25)),
    [],
  );
  const resetZoom = useCallback(() => setZoom(1), []);

  useEffect(() => {
    let cancelled = false;
    setZoom(1);
    setIsLoading(true);
    setError(null);
    setContent(null);
    setTruncated(false);
    setTruncatedTotal(0);
    setImageSrc(null);
    setOfficePreview(null);
    setOfficeView("visual");
    setMdView("rendered");

    if (!supported || isPdf || isVideo || isAudio) {
      setIsLoading(false);
      return;
    }

    if (isImage) {
      // 走 local-file:// 协议(支持 Range/流式),省去 base64 体积膨胀与主线程解码;
      // 同步即可,加载与错误交给 <img> 自身处理。
      setImageSrc(localFileUrl(absolutePath));
      setIsLoading(false);
    } else if (isOffice) {
      window.filework
        .prepareOfficePreview(absolutePath)
        .then((result) => {
          if (!cancelled) {
            const hasContent = hasUsableOfficeContent(result.contentPreview);
            setOfficePreview(result);
            if (
              result.previewKind === "presentation" &&
              result.contentPreview?.kind === "presentation" &&
              result.contentPreview.slides.some((slide) => slide.previewPath)
            ) {
              setOfficeView("visual");
            } else if (result.previewKind === "content" && hasContent) {
              setOfficeView("content");
            } else {
              setError(LL.preview_readFileError());
            }
            setIsLoading(false);
          }
        })
        .catch((err) => {
          if (!cancelled) {
            setError(
              err instanceof Error ? err.message : LL.preview_readFileError(),
            );
            setIsLoading(false);
          }
        });
    } else {
      window.filework
        .readFilePreview(absolutePath)
        .then((result) => {
          if (!cancelled) {
            setContent(result.content);
            setTruncated(result.truncated);
            setTruncatedTotal(result.totalBytes);
            setIsLoading(false);
          }
        })
        .catch((err) => {
          if (!cancelled) {
            setError(
              err instanceof Error ? err.message : LL.preview_readFileError(),
            );
            setIsLoading(false);
          }
        });
    }

    return () => {
      cancelled = true;
    };
  }, [absolutePath, supported, isImage, isOffice, isPdf, isVideo, isAudio, LL]);

  const officeContentPreview = hasUsableOfficeContent(
    officePreview?.contentPreview,
  )
    ? officePreview.contentPreview
    : null;
  const officePresentationPreview =
    officeContentPreview?.kind === "presentation" ? officeContentPreview : null;
  const hasOfficeVisual = Boolean(
    officePresentationPreview?.slides.some((slide) => slide.previewPath),
  );
  const officeContentLabels: OfficeContentLabels = {
    emptyOfficeContent: LL.preview_emptyOfficeContent(),
    emptySheet: LL.preview_emptySheet(),
    selectElement: LL.preview_selectPptxElement(),
    selectedElement: LL.preview_selectedPptxElement(),
    slide: (index) => LL.preview_slide(index),
    speakerNotes: LL.preview_speakerNotes(),
  };

  return (
    <div className="flex h-full flex-col bg-background">
      {/* 文件名头(关闭由 Dock 头部统一负责) */}
      <div className="flex min-w-0 shrink-0 items-center gap-2 border-b border-border px-4 py-2">
        <span className="truncate text-sm font-medium text-foreground">
          {fileName}
        </span>
        {ext && (
          <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
            {ext}
          </span>
        )}
        {/* markdown 源码/预览切换:仅 markdown 且内容就绪时出现,贴右。 */}
        {isMarkdown && !isLoading && !error && content !== null && (
          <div className="ml-auto flex shrink-0 items-center rounded-md border border-border p-0.5">
            <button
              type="button"
              onClick={() => setMdView("rendered")}
              title={LL.preview_viewRendered()}
              aria-label={LL.preview_viewRendered()}
              aria-pressed={mdView === "rendered"}
              className={cn(
                "rounded p-1 transition-colors",
                mdView === "rendered"
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Eye className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => setMdView("source")}
              title={LL.preview_viewSource()}
              aria-label={LL.preview_viewSource()}
              aria-pressed={mdView === "source"}
              className={cn(
                "rounded p-1 transition-colors",
                mdView === "source"
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Code2 className="h-4 w-4" />
            </button>
          </div>
        )}
        {/* html 文件:在网页面板渲染为活页面(走 local-file:// 协议,
            内联脚本/样式可执行,适合预览打包好的 HTML artifact)。 */}
        {isHtml && !isLoading && !error && (
          <button
            type="button"
            onClick={() =>
              window.dispatchEvent(
                new CustomEvent("filework:open-web", {
                  detail: { url: localFileUrl(absolutePath) },
                }),
              )
            }
            title={LL.preview_openInBrowser()}
            aria-label={LL.preview_openInBrowser()}
            className="ml-auto flex shrink-0 items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <Globe className="h-3.5 w-3.5" />
            {LL.preview_openInBrowser()}
          </button>
        )}
        {isOffice &&
          !isLoading &&
          !error &&
          hasOfficeVisual &&
          officeContentPreview && (
            <div className="ml-auto flex shrink-0 items-center rounded-md border border-border p-0.5">
              <button
                type="button"
                onClick={() => setOfficeView("visual")}
                title={LL.preview_viewVisual()}
                aria-label={LL.preview_viewVisual()}
                aria-pressed={officeView === "visual"}
                className={cn(
                  "rounded p-1 transition-colors",
                  officeView === "visual"
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Eye className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => setOfficeView("content")}
                title={LL.preview_viewContent()}
                aria-label={LL.preview_viewContent()}
                aria-pressed={officeView === "content"}
                className={cn(
                  "rounded p-1 transition-colors",
                  officeView === "content"
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <FileText className="h-4 w-4" />
              </button>
            </div>
          )}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto">
        {isLoading && (
          <div className="flex items-center justify-center h-full gap-2 text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span className="text-sm">{LL.preview_loading()}</span>
          </div>
        )}

        {!isLoading && !supported && (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground px-6">
            <FileWarning className="w-10 h-10" />
            <p className="text-sm text-center">
              {LL.preview_unsupported()}{" "}
              <span className="font-mono text-foreground">
                {ext || LL.preview_unsupportedType()}
              </span>{" "}
              {LL.preview_files()}
            </p>
          </div>
        )}

        {!isLoading && error && (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-destructive px-6">
            <p className="text-sm text-center">{error}</p>
          </div>
        )}

        {!isLoading && supported && content !== null && (
          <div className="flex h-full flex-col">
            {truncated && (
              <div className="shrink-0 border-b border-border bg-amber-500/10 px-4 py-1.5 text-xs text-amber-600 dark:text-amber-400">
                {LL.preview_truncated(formatBytes(truncatedTotal))}
              </div>
            )}
            {isMarkdown && mdView === "rendered" ? (
              // 预览模式:复用聊天的 Streamdown 渲染(cjk/数学/表格/代码块/链接路由一致)。
              <div className="min-h-0 flex-1 overflow-auto px-6 py-4">
                <MessageResponse>{content}</MessageResponse>
              </div>
            ) : (
              <CodeViewer
                code={content}
                filename={fileName}
                className="min-h-0 flex-1"
              />
            )}
          </div>
        )}

        {!isLoading && !error && isImage && imageSrc && (
          <div className="flex flex-col h-full">
            <div className="flex items-center justify-center gap-1 px-3 py-1.5 border-b border-border shrink-0">
              <button
                type="button"
                onClick={zoomOut}
                className="rounded p-1 hover:bg-accent transition-colors"
                aria-label={LL.preview_zoomOut()}
              >
                <ZoomOut className="w-4 h-4 text-muted-foreground" />
              </button>
              <button
                type="button"
                onClick={resetZoom}
                className="rounded px-2 py-0.5 hover:bg-accent transition-colors text-xs text-muted-foreground min-w-[3.5rem] text-center"
              >
                {Math.round(zoom * 100)}%
              </button>
              <button
                type="button"
                onClick={zoomIn}
                className="rounded p-1 hover:bg-accent transition-colors"
                aria-label={LL.preview_zoomIn()}
              >
                <ZoomIn className="w-4 h-4 text-muted-foreground" />
              </button>
            </div>
            <div className="flex-1 overflow-auto flex items-center justify-center p-4 bg-[repeating-conic-gradient(hsl(var(--muted))_0%_25%,transparent_0%_50%)] bg-[length:16px_16px]">
              <img
                src={imageSrc}
                alt={fileName}
                className="max-w-none transition-transform duration-150"
                style={{ transform: `scale(${zoom})` }}
                draggable={false}
                onError={() => setError(LL.preview_readImageError())}
              />
            </div>
          </div>
        )}

        {!isLoading && isPdf && <PdfViewer filePath={filePath} />}

        {!isLoading &&
          !error &&
          isOffice &&
          officeView === "visual" &&
          officePresentationPreview && (
            <div className="flex h-full flex-col">
              <div className="flex shrink-0 items-center justify-center gap-1 border-b border-border px-3 py-1.5">
                <button
                  type="button"
                  onClick={zoomOut}
                  className="rounded p-1 transition-colors hover:bg-accent"
                  aria-label={LL.preview_zoomOut()}
                >
                  <ZoomOut className="h-4 w-4 text-muted-foreground" />
                </button>
                <button
                  type="button"
                  onClick={resetZoom}
                  className="min-w-[3.5rem] rounded px-2 py-0.5 text-center text-xs text-muted-foreground hover:bg-accent"
                >
                  {Math.round(zoom * 100)}%
                </button>
                <button
                  type="button"
                  onClick={zoomIn}
                  className="rounded p-1 transition-colors hover:bg-accent"
                  aria-label={LL.preview_zoomIn()}
                >
                  <ZoomIn className="h-4 w-4 text-muted-foreground" />
                </button>
              </div>
              <div className="min-h-0 flex-1">
                <OfficePresentationPreviewPane
                  labels={officeContentLabels}
                  preview={officePresentationPreview}
                  sourcePath={absolutePath}
                  sourceRevision={officePreview?.cacheKey ?? ""}
                  zoom={zoom}
                />
              </div>
            </div>
          )}

        {!isLoading &&
          !error &&
          isOffice &&
          officeView === "content" &&
          officeContentPreview && (
            <div className="flex h-full flex-col">
              <div className="min-h-0 flex-1">
                <OfficeContentPreviewPane
                  key={officePreview?.cacheKey}
                  preview={officeContentPreview}
                  labels={officeContentLabels}
                />
              </div>
            </div>
          )}

        {!isLoading && isVideo && (
          <VideoViewer filePath={filePath} fileName={fileName} />
        )}

        {!isLoading && isAudio && (
          <AudioViewer filePath={filePath} fileName={fileName} />
        )}
      </div>
    </div>
  );
};
