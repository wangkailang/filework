// 布局几何:左栏 / Dock 宽度 clamp,以及 Dock 在窗口里该用分栏还是浮层。
// 纯函数、无 React,便于单测与复用。

export const RAIL_MIN_WIDTH = 180;
export const RAIL_MAX_WIDTH = 480;
export const RAIL_DEFAULT_WIDTH = 256;

export const DOCK_MIN_WIDTH = 280;
export const DOCK_MAX_WIDTH = 720;
export const DOCK_DEFAULT_WIDTH = 420;

/** 对话区的最小可读宽度;低于它时 Dock 改用浮层,避免重演"聊天被压到 30%"。 */
export const MIN_CHAT_WIDTH = 420;

const clamp = (
  n: number,
  min: number,
  max: number,
  fallback: number,
): number => (Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback);

export const clampRailWidth = (n: number): number =>
  clamp(n, RAIL_MIN_WIDTH, RAIL_MAX_WIDTH, RAIL_MIN_WIDTH);

export const clampDockWidth = (n: number): number =>
  clamp(n, DOCK_MIN_WIDTH, DOCK_MAX_WIDTH, DOCK_DEFAULT_WIDTH);

export type DockMode = "split" | "overlay";

/** 窗口放不下"左栏 + 最小对话宽 + Dock"时返回 "overlay",否则 "split"。 */
export const resolveDockMode = (args: {
  windowWidth: number;
  railWidth: number;
  railCollapsed: boolean;
  dockWidth: number;
}): DockMode => {
  const rail = args.railCollapsed ? 0 : args.railWidth;
  const remainingForChat = args.windowWidth - rail - args.dockWidth;
  return remainingForChat < MIN_CHAT_WIDTH ? "overlay" : "split";
};
