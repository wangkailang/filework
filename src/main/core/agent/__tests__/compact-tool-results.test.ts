import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";

import { compactToolResults } from "../compact-tool-results";

function toolMsg(id: string, value: string): ModelMessage {
  return {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: id,
        toolName: "webFetch",
        output: { type: "text", value },
      },
    ],
  } as ModelMessage;
}

const big = "X".repeat(50_000);
const small = "ok";

describe("compactToolResults", () => {
  it("returns null when there is 0 or 1 tool message", () => {
    expect(compactToolResults([{ role: "user", content: "hi" }])).toBeNull();
    expect(compactToolResults([toolMsg("a", big)])).toBeNull();
  });

  it("clamps an older oversized result but leaves the latest intact", () => {
    const messages: ModelMessage[] = [
      toolMsg("old", big),
      { role: "assistant", content: "thinking" },
      toolMsg("new", big),
    ];
    const out = compactToolResults(messages);
    expect(out).not.toBeNull();

    const oldOut = (
      out?.[0] as { content: Array<{ output: { value: string } }> }
    ).content[0].output.value;
    const newOut = (
      out?.[2] as { content: Array<{ output: { value: string } }> }
    ).content[0].output.value;

    expect(oldOut.length).toBeLessThan(big.length);
    expect(oldOut).toContain("elided to save context");
    expect(newOut).toBe(big); // 最新的工具结果保持不变
  });

  it("leaves small older results unchanged (returns null)", () => {
    const messages: ModelMessage[] = [
      toolMsg("old", small),
      toolMsg("new", big),
    ];
    expect(compactToolResults(messages)).toBeNull();
  });

  it("preserves toolCallId/toolName when clamping", () => {
    const messages: ModelMessage[] = [
      toolMsg("keep-id", big),
      toolMsg("new", small),
    ];
    const out = compactToolResults(messages);
    const part = (
      out?.[0] as { content: Array<{ toolCallId: string; toolName: string }> }
    ).content[0];
    expect(part.toolCallId).toBe("keep-id");
    expect(part.toolName).toBe("webFetch");
  });
});
