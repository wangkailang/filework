import { FolderOpenIcon, X } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

interface ImageLightboxProps {
  src: string;
  alt?: string;
  /** 显示在图片下方(提示词、文件名等)。 */
  caption?: ReactNode;
  /**
   * 文件系统绝对路径。提供后会显示一个「在 Finder 中显示」
   * 按钮 —— 仅对我们自有的 `local-file://` 来源有意义。
   */
  revealPath?: string;
  onClose: () => void;
}

/**
 * 单图灯箱。按 Esc 或点击背景关闭。同级的轮播
 * 实现位于 ImageGallery,那个保持在图集作用域内(在图集
 * 各项之间键盘导航)。本组件用于用户附件和生成图片的
 * 单张图片预览。
 */
export const ImageLightbox = ({
  src,
  alt,
  caption,
  revealPath,
  onClose,
}: ImageLightboxProps) => {
  // 父组件以内联箭头函数传入 `onClose`,因此它的引用
  // 每次渲染都会变化。让 keydown 监听器只挂载一次(空依赖),
  // 并通过 ref 读取最新的处理函数,以避免反复添加/移除
  // 监听器以及由此带来的短暂无监听器空档。
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Portal to body so a `position: fixed` ancestor with `transform`
  // /`overflow-hidden` doesn't reanchor the lightbox or clip the close
  // button. `titlebar-no-drag` is required because the App's top 48px
  // is a `-webkit-app-region: drag` zone — without this, the close
  // and reveal-in-Finder buttons (at top-4/right-4) get their clicks
  // captured by Electron as window-drag instead of firing onClick.
  return createPortal(
    <div className="titlebar-no-drag fixed inset-0 z-50">
      {/* Backdrop click target. `aria-hidden` + `tabIndex={-1}` keeps
          screen readers from announcing a second "关闭" button (the
          corner X covers that) and removes the invisible full-screen
          element from the keyboard tab order. */}
      <button
        type="button"
        aria-hidden="true"
        tabIndex={-1}
        onClick={onClose}
        className="absolute inset-0 bg-black/80"
      />
      <button
        type="button"
        aria-label="关闭"
        onClick={onClose}
        className="absolute right-4 top-4 z-10 rounded-full bg-white/10 p-2 text-white hover:bg-white/20"
      >
        <X className="h-5 w-5" />
      </button>
      {revealPath && (
        <button
          type="button"
          aria-label="在 Finder 中显示"
          onClick={() => window.filework.showInFinder(revealPath)}
          title="在 Finder 中显示"
          className="absolute right-16 top-4 z-10 rounded-full bg-white/10 p-2 text-white hover:bg-white/20"
        >
          <FolderOpenIcon className="h-5 w-5" />
        </button>
      )}
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-4">
        <div className="pointer-events-auto flex max-h-full max-w-full flex-col items-center gap-3">
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
    </div>,
    document.body,
  );
};
