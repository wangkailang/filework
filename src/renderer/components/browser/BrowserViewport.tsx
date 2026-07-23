import { useCallback, useEffect, useRef } from "react";

import type { BrowserViewportBounds } from "../../../shared/browser";

export const shouldOccludeBrowser = ({
  hasWorkspace,
  dockOpen,
  dockTab,
  modalOpen,
}: {
  hasWorkspace: boolean;
  dockOpen: boolean;
  dockTab: string;
  modalOpen: boolean;
}): boolean => !hasWorkspace || !dockOpen || dockTab !== "web" || modalOpen;

export const roundBrowserViewportBounds = (
  rect: Pick<DOMRect, "x" | "y" | "width" | "height">,
): BrowserViewportBounds => ({
  x: Math.max(0, Math.round(rect.x)),
  y: Math.max(0, Math.round(rect.y)),
  width: Math.max(0, Math.round(rect.width)),
  height: Math.max(0, Math.round(rect.height)),
});

export const BrowserViewport = ({ active }: { active: boolean }) => {
  const elementRef = useRef<HTMLDivElement | null>(null);

  const publishBounds = useCallback(() => {
    const element = elementRef.current;
    if (!active || !element) {
      void window.filework.browser.setViewport(null);
      return;
    }
    void window.filework.browser.setViewport(
      roundBrowserViewportBounds(element.getBoundingClientRect()),
    );
  }, [active]);

  useEffect(() => {
    publishBounds();
    const element = elementRef.current;
    const observer =
      element && typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(publishBounds)
        : null;
    if (element) observer?.observe(element);
    window.addEventListener("resize", publishBounds);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", publishBounds);
      void window.filework.browser.setViewport(null);
    };
  }, [publishBounds]);

  return (
    <div
      ref={elementRef}
      data-browser-viewport="true"
      aria-hidden="true"
      className="absolute inset-0 bg-background"
    />
  );
};
