import type { MouseEvent } from "react";
import { useBrowserRouter } from "./context";

interface LinkHandlers {
  onClick: (event: MouseEvent<HTMLAnchorElement>) => void;
  /** 在 Chromium 中,中键点击 `<a>` 触发的是 `auxclick` 而非 `click`。
   *  锚点必须同时绑定两者,才能让"在系统浏览器打开"生效。 */
  onAuxClick: (event: MouseEvent<HTMLAnchorElement>) => void;
}

const PANEL_SCHEMES = /^https?:$/i;
const OS_HANDOFF_SCHEMES = /^(mailto|tel):$/i;

/**
 * `<a>` 标签的点击处理器,将 URL 路由到右侧的
 * BrowserPanel。
 *
 * 安全性:每次主键点击都在协议检查之前 preventDefault ——
 * 以防路由分支落空时,游离的 `javascript:` / `data:` href
 * 在渲染进程中执行。
 * 右键 → "打开链接"会完全绕过 onClick;该路径
 * 由主进程在 mainWindow 上的 will-navigate 拦截处理。
 *
 * Cmd/Ctrl-点击 → 系统浏览器。中键点击 → 系统浏览器(经由
 * onAuxClick)。普通左键点击 → http(s) 走面板,
 * mailto:/tel: 交给系统处理,其他一律丢弃(并打印 warn)。
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
      // click 仅响应主键;次键点击会冒泡
      // 到系统上下文菜单,该菜单在主进程中被拦截。
      if (event.button !== 0 && !forceOs) {
        event.preventDefault();
        return;
      }
      route(event, forceOs);
    },
    onAuxClick: (event) => {
      // event.button === 1 表示中键。其他值(2 = 次键)是
      // 上下文菜单键;放行以便系统菜单打开,
      // 随后 will-navigate 会捕获用户选择的任何导航。
      if (event.button !== 1) return;
      route(event, true);
    },
  };
}
