import { FolderOpenIcon, X } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

interface ImageLightboxProps {
  src: string;
  alt?: string;
  /** Shown beneath the image (prompt, filename, etc). */
  caption?: ReactNode;
  /**
   * Absolute filesystem path. When provided, surfaces a "reveal in Finder"
   * button — only meaningful for `local-file://` sources we own.
   */
  revealPath?: string;
  onClose: () => void;
}

/**
 * Single-image lightbox. Esc and backdrop click close. Sibling carousel
 * exists in ImageGallery; that one stays gallery-scoped (keyboard
 * navigation between gallery items). This component is for one-off image
 * previews on user attachments and generated images.
 */
export const ImageLightbox = ({
  src,
  alt,
  caption,
  revealPath,
  onClose,
}: ImageLightboxProps) => {
  // Parents pass an inline arrow for `onClose`, so its identity changes
  // every render. Keep the keydown listener attached once (empty deps)
  // and read the latest handler through a ref to avoid add/remove
  // thrash and the tiny no-listener gap that comes with it.
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
