import { FileWarning, Loader2, X, ZoomIn, ZoomOut } from "lucide-react";
import { useEffect, useState, useCallback } from "react";
import { CodeViewer, getFileExtension, isSupportedFile } from "../ai-elements/code-viewer";
import { PdfViewer } from "./PdfViewer";
import { VideoViewer } from "./VideoViewer";

const isPdfFile = (filename: string): boolean => {
  return getFileExtension(filename).toLowerCase() === ".pdf";
};

const IMAGE_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".svg", ".ico", ".avif", ".tiff", ".tif",
]);

const isImageFile = (filename: string): boolean => {
  return IMAGE_EXTENSIONS.has(getFileExtension(filename).toLowerCase());
};

const VIDEO_EXTENSIONS = new Set([
  ".mp4", ".webm", ".ogg", ".mov", ".m4v",
]);

const isVideoFile = (filename: string): boolean => {
  return VIDEO_EXTENSIONS.has(getFileExtension(filename).toLowerCase());
};

const getMimeType = (filename: string): string => {
  const ext = getFileExtension(filename).toLowerCase();
  const map: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".bmp": "image/bmp",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".avif": "image/avif",
    ".tiff": "image/tiff",
    ".tif": "image/tiff",
  };
  return map[ext] || "image/png";
};

interface FilePreviewPanelProps {
  filePath: string;
  onClose: () => void;
}

export const FilePreviewPanel = ({ filePath, onClose }: FilePreviewPanelProps) => {
  const [content, setContent] = useState<string | null>(null);
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [zoom, setZoom] = useState(1);

  const fileName = filePath.split("/").pop() || filePath;
  const ext = getFileExtension(fileName);
  const isPdf = isPdfFile(fileName);
  const isImage = isImageFile(fileName);
  const isVideo = isVideoFile(fileName);
  const supported = isSupportedFile(fileName) || isPdf || isImage || isVideo;

  const zoomIn = useCallback(() => setZoom((z) => Math.min(z + 0.25, 5)), []);
  const zoomOut = useCallback(() => setZoom((z) => Math.max(z - 0.25, 0.25)), []);
  const resetZoom = useCallback(() => setZoom(1), []);

  useEffect(() => {
    setZoom(1);
  }, [filePath]);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    setContent(null);
    setImageSrc(null);

    if (!supported || isPdf || isVideo) {
      setIsLoading(false);
      return;
    }

    if (isImage) {
      window.filework
        .readFileBase64(filePath)
        .then((base64) => {
          if (!cancelled) {
            const mime = getMimeType(fileName);
            setImageSrc(`data:${mime};base64,${base64}`);
            setIsLoading(false);
          }
        })
        .catch((err) => {
          if (!cancelled) {
            setError(err instanceof Error ? err.message : "读取图片失败");
            setIsLoading(false);
          }
        });
    } else {
      window.filework
        .readFile(filePath)
        .then((text) => {
          if (!cancelled) {
            setContent(text);
            setIsLoading(false);
          }
        })
        .catch((err) => {
          if (!cancelled) {
            setError(err instanceof Error ? err.message : "读取文件失败");
            setIsLoading(false);
          }
        });
    }

    return () => {
      cancelled = true;
    };
  }, [filePath, supported, isImage]);

  return (
    <div className="flex h-full flex-col bg-background border-r border-border">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-border shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="truncate text-sm font-medium text-foreground">{fileName}</span>
          {ext && (
            <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
              {ext}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 rounded p-1 hover:bg-accent transition-colors"
          aria-label="关闭预览"
        >
          <X className="w-4 h-4 text-muted-foreground" />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto">
        {isLoading && (
          <div className="flex items-center justify-center h-full gap-2 text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span className="text-sm">读取文件中...</span>
          </div>
        )}

        {!isLoading && !supported && (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground px-6">
            <FileWarning className="w-10 h-10" />
            <p className="text-sm text-center">
              暂不支持预览 <span className="font-mono text-foreground">{ext || "此类型"}</span> 文件
            </p>
          </div>
        )}

        {!isLoading && error && (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-destructive px-6">
            <p className="text-sm text-center">{error}</p>
          </div>
        )}

        {!isLoading && supported && content !== null && (
          <CodeViewer code={content} filename={fileName} className="h-full" />
        )}

        {!isLoading && isImage && imageSrc && (
          <div className="flex flex-col h-full">
            <div className="flex items-center justify-center gap-1 px-3 py-1.5 border-b border-border shrink-0">
              <button
                type="button"
                onClick={zoomOut}
                className="rounded p-1 hover:bg-accent transition-colors"
                aria-label="缩小"
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
                aria-label="放大"
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
              />
            </div>
          </div>
        )}

        {!isLoading && isPdf && (
          <PdfViewer filePath={filePath} />
        )}

        {!isLoading && isVideo && (
          <VideoViewer filePath={filePath} fileName={fileName} />
        )}
      </div>
    </div>
  );
};
