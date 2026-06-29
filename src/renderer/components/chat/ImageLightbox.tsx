import { DownloadIcon, FolderOpenIcon, X } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";

interface ImageLightboxProps {
  src: string;
  alt?: string;
  /** Suggested filename for the browser download action. */
  downloadName?: string;
  /** 显示在图片下方(提示词、文件名等)。 */
  caption?: ReactNode;
  /**
   * 文件系统绝对路径。提供后会显示一个「在 Finder 中显示」
   * 按钮 —— 仅对我们自有的 `local-file://` 来源有意义。
   */
  revealPath?: string;
  onClose: () => void;
}

const basename = (value: string): string | null => {
  const normalized = value.split(/[?#]/, 1)[0]?.replace(/\\/g, "/") ?? "";
  const name = normalized.split("/").filter(Boolean).pop();
  if (!name) return null;
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
};

export const ImageDownloadButton = ({
  src,
  downloadName,
}: {
  src: string;
  downloadName?: string | null;
}) => (
  <Button
    asChild
    size="icon-sm"
    variant="ghost"
    className="rounded-full bg-white/10 text-white hover:bg-white/20 hover:text-white"
  >
    <a
      href={src}
      download={downloadName ?? basename(src) ?? "image"}
      aria-label="下载图片"
      title="下载图片"
    >
      <DownloadIcon />
    </a>
  </Button>
);

/**
 * 单图灯箱。按 Esc 或点击背景关闭。同级的轮播
 * 实现位于 ImageGallery,那个保持在图集作用域内(在图集
 * 各项之间键盘导航)。本组件用于用户附件和生成图片的
 * 单张图片预览。
 */
export const ImageLightbox = ({
  src,
  alt,
  downloadName,
  caption,
  revealPath,
  onClose,
}: ImageLightboxProps) => {
  const effectiveDownloadName =
    downloadName ?? (revealPath ? basename(revealPath) : null) ?? basename(src);

  return (
    <Dialog
      open
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="titlebar-no-drag inset-0! left-0! top-0! h-screen! w-screen! max-w-none! translate-x-0! translate-y-0! rounded-none! border-0! bg-black/90! p-0! text-white! shadow-none! ring-0!"
      >
        <DialogHeader className="sr-only">
          <DialogTitle>Image preview</DialogTitle>
          <DialogDescription>
            Preview the selected image in full size.
          </DialogDescription>
        </DialogHeader>
        <div className="absolute right-4 top-4 z-10 flex items-center gap-2">
          <ImageDownloadButton src={src} downloadName={effectiveDownloadName} />
          {revealPath && (
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label="在 Finder 中显示"
              title="在 Finder 中显示"
              onClick={() => window.filework.showInFinder(revealPath)}
              className="rounded-full bg-white/10 text-white hover:bg-white/20 hover:text-white"
            >
              <FolderOpenIcon />
            </Button>
          )}
          <DialogClose asChild>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label="关闭"
              className="rounded-full bg-white/10 text-white hover:bg-white/20 hover:text-white"
            >
              <X />
            </Button>
          </DialogClose>
        </div>
        <div className="flex h-full w-full items-center justify-center p-4">
          <div className="flex max-h-full max-w-full flex-col items-center gap-3">
            <img
              src={src}
              alt={alt ?? ""}
              className="max-h-[80vh] max-w-[90vw] rounded object-contain"
            />
            {caption && (
              <div className="max-w-[90vw] text-center text-xs text-white/80">
                {caption}
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};
