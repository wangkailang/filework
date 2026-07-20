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

  it("keeps a short previous summary intact when memory chunks exist", () => {
    const summary = [
      "## 已完成",
      "- fact A",
      "- fact B",
      "- fact C",
      "## 待处理",
      "- fact F",
    ].join("\n");
    const result = buildRollingSummaryContext({
      previousSummary: summary,
      memoryChunks: [
        { text: "fact A", embedding: null },
        { text: "fact F", embedding: null },
      ],
      maxChars: 500,
    });

    expect(result).toEqual({
      text: summary,
      wasTruncated: false,
      recalledChunks: 0,
    });
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

  it("uses vector-ranked memory chunks as recall candidates", () => {
    const result = buildRollingSummaryContext({
      previousSummary: [
        "## 已完成",
        "- first project setup note",
        "- unrelated visual polish details",
        "## 待处理",
        "- final unrelated cleanup",
      ].join("\n"),
      memoryChunks: [
        { text: "sidebar color and spacing memory", embedding: null },
        {
          text: "auth session token renewal regression memory",
          embedding: null,
        },
      ],
      query: "token renewal auth regression",
      maxChars: 220,
      maxSnippets: 1,
    });

    expect(result?.wasTruncated).toBe(false);
    expect(result?.recalledChunks).toBe(1);
    expect(result?.text).toContain("auth session token renewal");
    expect(result?.text).not.toContain("sidebar color");
  });
});
