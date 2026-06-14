import { describe, expect, it } from "vitest";
import { resolveThemeMode } from "../theme";

describe("resolveThemeMode", () => {
  it("显式主题直接生效", () => {
    expect(resolveThemeMode("dark", false)).toBe("dark");
    expect(resolveThemeMode("light", true)).toBe("light");
  });

  it("system 根据系统偏好解析", () => {
    expect(resolveThemeMode("system", true)).toBe("dark");
    expect(resolveThemeMode("system", false)).toBe("light");
  });
});
