import { describe, expect, it } from "vitest";
import { upsertContextCompressedPart } from "../context-compression-part";
import type { MessagePart } from "../types";

describe("upsertContextCompressedPart", () => {
  it("adds a context compression marker without changing text content", () => {
    const parts: MessagePart[] = [{ type: "text", text: "继续执行" }];

    const next = upsertContextCompressedPart(parts, {
      compressedTokens: 40_000,
      originalTokens: 401_000,
    });

    expect(next).toEqual([
      {
        type: "context-compressed",
        compressedTokens: 40_000,
        originalTokens: 401_000,
      },
      { type: "text", text: "继续执行" },
    ]);
  });

  it("updates an existing context compression marker instead of duplicating it", () => {
    const parts: MessagePart[] = [
      {
        type: "context-compressed",
        compressedTokens: 50_000,
        originalTokens: 300_000,
      },
      { type: "text", text: "继续执行" },
    ];

    const next = upsertContextCompressedPart(parts, {
      compressedTokens: 40_000,
      originalTokens: 401_000,
    });

    expect(
      next.filter((part) => part.type === "context-compressed"),
    ).toHaveLength(1);
    expect(next[0]).toEqual({
      type: "context-compressed",
      compressedTokens: 40_000,
      originalTokens: 401_000,
    });
  });
});
