import { describe, expect, it, vi } from "vitest";
import { buildTools } from "../ai-tool-permissions";

describe("buildTools", () => {
  it("does not expose stateful cache mutation tools by default", () => {
    const sender = {
      isDestroyed: () => false,
      send: vi.fn(),
    } as unknown as Electron.WebContents;

    const tools = buildTools(sender, "task-1");
    expect(tools.clearDirectoryCache).toBeUndefined();
  });
});
