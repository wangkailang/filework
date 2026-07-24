// 布局几何:左栏 / Dock 宽度 clamp,以及 Dock 在窗口里该用分栏还是浮层。
// 纯函数、无 React,便于单测与复用。

export const RAIL_MIN_WIDTH = 180;
export const RAIL_MAX_WIDTH = 480;
export const RAIL_DEFAULT_WIDTH = 256;
export const RAIL_META_BADGE_MIN_WIDTH = 224;

export const DOCK_MIN_WIDTH = 280;
export const DOCK_MAX_WIDTH = 720;
export const DOCK_DEFAULT_WIDTH = 420;

/** 对话区的最小可读宽度;低于它时 Dock 改用浮层,避免长任务输出失去可扫读性。 */
export const MIN_CHAT_WIDTH = 560;

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

export type DockGeometryArgs = {
  windowWidth: number;
  railWidth: number;
  railCollapsed: boolean;
  dockWidth: number;
};

const maxSplitDockWidth = (args: DockGeometryArgs): number => {
  const rail = args.railCollapsed ? 0 : args.railWidth;
  return args.windowWidth - rail - MIN_CHAT_WIDTH;
};

/**
 * 分栏时优先保住聊天阅读宽度，必要时临时收窄 Dock。用户保存的 Dock 宽度
 * 不会被窗口变化覆盖；窗口再次变宽后会恢复。
 */
export const resolveSplitDockWidth = (args: DockGeometryArgs): number =>
  Math.max(
    DOCK_MIN_WIDTH,
    Math.min(clampDockWidth(args.dockWidth), maxSplitDockWidth(args)),
  );

/**
 * 只在"最小 Dock + 最小聊天宽度"都无法并排时使用浮层。若只是用户把 Dock
 * 拉得较宽，则保持分栏并临时收窄 Dock，避免浮层遮住聊天内容。
 */
export const resolveDockMode = (args: DockGeometryArgs): DockMode =>
  maxSplitDockWidth(args) < DOCK_MIN_WIDTH ? "overlay" : "split";

/** 全屏 Dock 不应盖住展开中的左侧栏;折叠时铺满到窗口左边。 */
export const resolveFullscreenDockLeft = (args: {
  railWidth: number;
  railCollapsed: boolean;
}): number => (args.railCollapsed ? 0 : args.railWidth);

/** 全屏 Dock 必须从窗口顶部开始,避免露出底层聊天或工具栏。 */
export const resolveFullscreenDockTop = (): number => 0;

/** 左栏头部第二行空间有限:窄栏优先保留分支和 diff,隐藏来源徽标。 */
export const resolveRailMetaLayout = (
  railWidth: number,
): { showKindBadge: boolean } => ({
  showKindBadge: railWidth >= RAIL_META_BADGE_MIN_WIDTH,
});
