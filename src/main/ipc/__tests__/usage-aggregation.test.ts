import { describe, expect, it } from "vitest";
import {
  mergeTokenUsage,
  subagentUsageFromToolResult,
} from "../usage-aggregation";

describe("usage aggregation", () => {
  it("extracts usage from spawnSubagent reports", () => {
    const usage = subagentUsageFromToolResult({
      success: true,
      reports: [
        {
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        },
        {
          usage: { inputTokens: 7, outputTokens: 3, totalTokens: null },
        },
      ],
    });

    expect(usage).toEqual({
      inputTokens: 17,
      outputTokens: 8,
      totalTokens: 25,
    });
  });

  it("merges parent and subagent usage without dropping partial fields", () => {
    expect(
      mergeTokenUsage(
        { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
        { inputTokens: 30, outputTokens: null, totalTokens: 45 },
      ),
    ).toEqual({
      inputTokens: 130,
      outputTokens: 20,
      totalTokens: 165,
    });
  });

  it("returns null totals when no usage fields are present", () => {
    expect(mergeTokenUsage(undefined, undefined)).toEqual({
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
    });
  });
});
