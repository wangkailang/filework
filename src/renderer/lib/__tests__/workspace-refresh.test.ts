import { describe, expect, it } from "vitest";

import { shouldRefreshFileTreeForToolResult } from "../workspace-refresh";

describe("shouldRefreshFileTreeForToolResult", () => {
  it("refreshes after successful file tree mutations", () => {
    expect(
      shouldRefreshFileTreeForToolResult("deleteFile", { success: true }),
    ).toBe(true);
    expect(
      shouldRefreshFileTreeForToolResult("createDirectory", { success: true }),
    ).toBe(true);
    expect(
      shouldRefreshFileTreeForToolResult("restoreFromTrash", {
        restoredTo: "/workspace/a.md",
      }),
    ).toBe(true);
  });

  it("does not refresh after denied or failed mutation results", () => {
    expect(
      shouldRefreshFileTreeForToolResult("deleteFile", { denied: true }),
    ).toBe(false);
    expect(
      shouldRefreshFileTreeForToolResult("deleteFile", { success: false }),
    ).toBe(false);
    expect(
      shouldRefreshFileTreeForToolResult("deleteFile", { isError: true }),
    ).toBe(false);
  });

  it("does not refresh for read-only tools or generic shell commands", () => {
    expect(
      shouldRefreshFileTreeForToolResult("listDirectory", { entries: [] }),
    ).toBe(false);
    expect(shouldRefreshFileTreeForToolResult("runCommand", { code: 0 })).toBe(
      false,
    );
  });
});
