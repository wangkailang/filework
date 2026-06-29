import { describe, expect, it } from "vitest";
import { buildRollingSummaryContext } from "../rolling-summary";

describe("buildRollingSummaryContext", () => {
  it("keeps a short previous summary intact", () => {
    const result = buildRollingSummaryContext({
      previousSummary: "## 已完成\n- kept fact",
      query: "anything",
      maxChars: 200,
    });

    expect(result?.text).toBe("## 已完成\n- kept fact");
    expect(result?.wasTruncated).toBe(false);
    expect(result?.recalledChunks).toBe(0);
  });

  it("recalls matching chunks from a long previous summary with head and tail fallback", () => {
    const result = buildRollingSummaryContext({
      previousSummary: [
        "## 已完成",
        "- initial workspace scan completed",
        "- unrelated UI copy audit finished with no actionable changes",
        "- OAuth token renewal bug was isolated in auth/session.ts",
        "- theme polish was deferred",
        "- another unrelated note about sidebar spacing and icon alignment",
        "## 待处理",
        "- verify OAuth token renewal regression tests",
      ].join("\n"),
      query: "OAuth token renewal bug isolated auth session",
      maxChars: 180,
      maxSnippets: 1,
    });

    expect(result?.wasTruncated).toBe(true);
    expect(result?.recalledChunks).toBe(1);
    expect(result?.text).toContain("OAuth token renewal bug");
    expect(result?.text).toContain("initial workspace scan");
    expect(result?.text).toContain("verify OAuth token renewal");
  });
});
