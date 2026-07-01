import { describe, expect, it } from "vitest";

import { createSubagentChildren } from "../subagent-state";

describe("createSubagentChildren", () => {
  it("marks children beyond the concurrency window as queued", () => {
    const children = createSubagentChildren(
      Array.from({ length: 6 }, (_, index) => ({
        childTaskId: `child-${index + 1}`,
        goal: `分析目录 ${index + 1}`,
      })),
      4,
    );

    expect(children.map((child) => child.status)).toEqual([
      "running",
      "running",
      "running",
      "running",
      "queued",
      "queued",
    ]);
  });
});
