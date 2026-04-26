import { describe, expect, it, vi } from "vitest";
import { setTaskWorkspace } from "../ai-task-control";
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

  it("denies deleteFile when path is outside workspace", async () => {
    const sender = {
      isDestroyed: () => false,
      send: vi.fn(),
    } as unknown as Electron.WebContents;

    setTaskWorkspace("task-1", "/workspace");
    const tools = buildTools(sender, "task-1");

    const res = await tools.deleteFile.execute?.({ path: "/tmp/evil" }, {
      toolCallId: "t1",
      messages: [],
    } as unknown as import("ai").ToolExecutionOptions);

    expect(res).toEqual(expect.objectContaining({ denied: true }));
  });
});
