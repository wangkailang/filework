import { describe, expect, it } from "vitest";
import { embedTextToVector, rankVectorMemoryChunks } from "../memory-vector";

describe("memory vector recall", () => {
  it("produces normalized deterministic vectors", () => {
    const first = embedTextToVector("OAuth token renewal");
    const second = embedTextToVector("OAuth token renewal");

    expect(first).toEqual(second);
    expect(first.length).toBeGreaterThan(0);
    const magnitude = Math.sqrt(
      first.reduce((sum, value) => sum + value ** 2, 0),
    );
    expect(magnitude).toBeCloseTo(1, 5);
  });

  it("ranks memory chunks by vector similarity to the query", () => {
    const ranked = rankVectorMemoryChunks(
      [
        { text: "UI theme spacing and sidebar polish" },
        { text: "OAuth token renewal bug in auth session handling" },
        { text: "Build pipeline cache cleanup notes" },
      ],
      "auth session token renewal regression",
    );

    expect(ranked[0]?.text).toContain("OAuth token renewal");
    expect(ranked[0]?.score).toBeGreaterThan(ranked[1]?.score ?? 0);
  });
});
