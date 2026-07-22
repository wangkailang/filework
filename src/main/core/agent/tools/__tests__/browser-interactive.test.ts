import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../ipc/interactive-browser", () => ({
  clickInBrowserSession: vi.fn(),
  closeBrowserSession: vi.fn(),
  openBrowserSession: vi.fn(),
  snapshotBrowserSession: vi.fn(),
  typeInBrowserSession: vi.fn(),
}));

import {
  buildBrowserClickTool,
  buildBrowserOpenTool,
  buildBrowserTypeTool,
} from "../browser-interactive";

describe("interactive browser tool safety", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps opening a page read-only but gates click and type actions", () => {
    expect(buildBrowserOpenTool().safety).toBe("safe");
    expect(buildBrowserClickTool().safety).toBe("destructive");
    expect(buildBrowserTypeTool().safety).toBe("destructive");
  });
});
