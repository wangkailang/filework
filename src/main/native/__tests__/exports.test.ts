import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertNativeModuleShape } from "..";

describe("@filework/native exports", () => {
  it("does not expose the removed external Office conversion entrypoint", () => {
    const requireNative = createRequire(import.meta.url);
    const nativeModule = requireNative("@filework/native") as Record<
      string,
      unknown
    >;

    expect(nativeModule.prepareOfficePreviewNative).toBeUndefined();
  });

  it("accepts native bindings without the removed Office converter", () => {
    expect(() =>
      assertNativeModuleShape({
        directoryStats: () => undefined,
        findDuplicates: () => undefined,
        scanDirectoryLevel: () => undefined,
        searchFiles: () => undefined,
      }),
    ).not.toThrow();
  });

  it("rebuilds native bindings before app dev and production builds", () => {
    const packageJson = JSON.parse(
      readFileSync(join(process.cwd(), "package.json"), "utf8"),
    ) as {
      scripts: Record<string, string>;
    };

    expect(packageJson.scripts["native:build"]).toBe(
      "pnpm --filter @filework/native run build",
    );
    expect(packageJson.scripts.dev).toContain("pnpm native:build &&");
    expect(packageJson.scripts["dev:devtools"]).toContain(
      "pnpm native:build &&",
    );
    expect(packageJson.scripts.build).toContain("pnpm native:build &&");
  });
});
