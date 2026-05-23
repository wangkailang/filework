import type { MouseEvent } from "react";
import { useBrowserRouter } from "./context";

interface LinkHandlers {
  onClick: (event: MouseEvent<HTMLAnchorElement>) => void;
  /** Middle-click on `<a>` fires `auxclick` in Chromium, not `click`.
   *  Anchors must bind both to make the OS-browser escape work. */
  onAuxClick: (event: MouseEvent<HTMLAnchorElement>) => void;
}

const PANEL_SCHEMES = /^https?:$/i;
const OS_HANDOFF_SCHEMES = /^(mailto|tel):$/i;

/**
 * Click handler for `<a>` tags that routes URLs into the right-side
 * BrowserPanel.
 *
 * Security: every primary click is preventDefault'd before scheme
 * inspection — that stops a stray `javascript:` / `data:` href from
 * executing in the renderer if the route branch falls through.
 * Right-click → "Open Link" bypasses onClick entirely; that vector
 * is handled by the main-process will-navigate trap on mainWindow.
 *
 * Cmd/Ctrl-click → OS browser. Middle-click → OS browser (via
 * onAuxClick). Plain left-click → panel for http(s), OS hand-off for
 * mailto:/tel:, dropped (with a warn) for anything else.
 */
export function useLinkRouter(): LinkHandlers {
  const router = useBrowserRouter();

  const route = (
    event: MouseEvent<HTMLAnchorElement>,
    forceOsBrowser: boolean,
  ): void => {
    event.preventDefault();
    let parsed: URL;
    try {
      parsed = new URL(event.currentTarget.href);
    } catch {
      return;
    }
    const isPanelScheme = PANEL_SCHEMES.test(parsed.protocol);
    const isHandoff = OS_HANDOFF_SCHEMES.test(parsed.protocol);
    if (!isPanelScheme && !isHandoff) {
      console.warn(
        `[useLinkRouter] dropped link with disallowed scheme: ${parsed.protocol}`,
      );
      return;
    }
    if (forceOsBrowser || isHandoff || !router) {
      void window.filework.openExternal(parsed.href).catch((err) => {
        console.warn("[useLinkRouter] openExternal failed:", err);
      });
      return;
    }
    router.openInPanel(parsed.href);
  };

  return {
    onClick: (event) => {
      const forceOs = event.metaKey || event.ctrlKey;
      // Only react to primary button on click; secondary clicks bubble
      // to the OS context menu which is trapped in the main process.
      if (event.button !== 0 && !forceOs) {
        event.preventDefault();
        return;
      }
      route(event, forceOs);
    },
    onAuxClick: (event) => {
      // event.button === 1 = middle. Anything else (2 = secondary) is
      // the context-menu button; let it through so the OS menu opens,
      // then will-navigate catches any chosen navigation.
      if (event.button !== 1) return;
      route(event, true);
    },
  };
}
