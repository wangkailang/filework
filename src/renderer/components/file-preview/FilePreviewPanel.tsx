import {
  Code2,
  Eye,
  FileWarning,
  Loader2,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useI18nContext } from "../../i18n/i18n-react";
import { localFileUrl } from "../../lib/local-file-url";
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
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [zoom, setZoom] = useState(1);
  // markdown 视图模式:rendered=渲染预览(默认),source=原文件源码(带行号)。
  const [mdView, setMdView] = useState<"rendered" | "source">("rendered");

  const fileName = filePath.split("/").pop() || filePath;
  const absolutePath = filePath;
  const ext = getFileExtension(fileName);
  const isPdf = isPdfFile(fileName);
  const isImage = isImageFile(fileName);
  const isVideo = isVideoFile(fileName);
  const isAudio = isAudioFile(fileName);
  const isMarkdown = isMarkdownFile(fileName);
  const supported =
    isSupportedFile(fileName) || isPdf || isImage || isVideo || isAudio;

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
  }, [absolutePath, supported, isImage, isPdf, isVideo, isAudio, LL]);

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
