import type { SubagentChildView } from "./types";

export const createSubagentChildren = (
  children: Array<{ childTaskId: string; goal: string }>,
  concurrency: number,
): SubagentChildView[] =>
  children.map((child, index) => ({
    childTaskId: child.childTaskId,
    goal: child.goal,
    status: index < concurrency ? "running" : "queued",
    stepCount: 0,
    toolCalls: [],
    usage: {
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
    },
  }));
