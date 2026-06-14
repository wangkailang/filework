import { describe, expect, it } from "vitest";
import {
  clampDockWidth,
  clampRailWidth,
  DOCK_DEFAULT_WIDTH,
  DOCK_MAX_WIDTH,
  DOCK_MIN_WIDTH,
  RAIL_DEFAULT_WIDTH,
  RAIL_MAX_WIDTH,
  RAIL_MIN_WIDTH,
  resolveDockMode,
  resolveFullscreenDockLeft,
  resolveFullscreenDockTop,
  resolveRailMetaLayout,
} from "../layout-geometry";

describe("clampRailWidth", () => {
  it("夹在 [RAIL_MIN, RAIL_MAX] 区间", () => {
    expect(clampRailWidth(0)).toBe(RAIL_MIN_WIDTH);
    expect(clampRailWidth(9999)).toBe(RAIL_MAX_WIDTH);
    expect(clampRailWidth(300)).toBe(300);
  });
  it("NaN 回落到 RAIL_MIN", () => {
    expect(clampRailWidth(Number.NaN)).toBe(RAIL_MIN_WIDTH);
  });
});

describe("clampDockWidth", () => {
  it("夹在 [DOCK_MIN, DOCK_MAX] 区间", () => {
    expect(clampDockWidth(0)).toBe(DOCK_MIN_WIDTH);
    expect(clampDockWidth(99999)).toBe(DOCK_MAX_WIDTH);
    expect(clampDockWidth(DOCK_DEFAULT_WIDTH)).toBe(DOCK_DEFAULT_WIDTH);
  });
});

describe("resolveDockMode", () => {
  it("空间够 → split", () => {
    expect(
      resolveDockMode({
        windowWidth: 1440,
        railWidth: 256,
        railCollapsed: false,
        dockWidth: 420,
      }),
    ).toBe("split");
  });
  it("空间不足以容纳最小对话宽 → overlay", () => {
    // 1000 - 256 - 420 = 324 < MIN_CHAT_WIDTH(420)
    expect(
      resolveDockMode({
        windowWidth: 1000,
        railWidth: 256,
        railCollapsed: false,
        dockWidth: 420,
      }),
    ).toBe("overlay");
  });
  it("rail 折叠时把其宽度计为 0", () => {
    // 折叠:1000 - 0 - 420 = 580 >= 420 → split
    expect(
      resolveDockMode({
        windowWidth: 1000,
        railWidth: 256,
        railCollapsed: true,
        dockWidth: 420,
      }),
    ).toBe("split");
  });
});

describe("resolveFullscreenDockLeft", () => {
  it("左栏展开时全屏 Dock 让出左栏宽度", () => {
    expect(
      resolveFullscreenDockLeft({
        railWidth: 308,
        railCollapsed: false,
      }),
    ).toBe(308);
  });

  it("左栏折叠时全屏 Dock 不留左侧空白", () => {
    expect(
      resolveFullscreenDockLeft({
        railWidth: 308,
        railCollapsed: true,
      }),
    ).toBe(0);
  });
});

describe("resolveFullscreenDockTop", () => {
  it("全屏 Dock 从窗口顶部开始,不露出底层内容", () => {
    expect(resolveFullscreenDockTop()).toBe(0);
  });
});

describe("resolveRailMetaLayout", () => {
  it("最窄左栏隐藏来源徽标,给分支 chip 留出空间", () => {
    expect(resolveRailMetaLayout(RAIL_MIN_WIDTH).showKindBadge).toBe(false);
  });

  it("默认宽度左栏保留来源徽标", () => {
    expect(resolveRailMetaLayout(RAIL_DEFAULT_WIDTH).showKindBadge).toBe(true);
  });
});
