/**
 * 测试 GAIA 专用 reflection 规则 deepResearchAnswerReady：当本轮 deepResearch
 * 已返回 high/medium 置信的 directAnswer、但模型还没出 FINAL ANSWER 时，强制收口。
 */
import { describe, expect, it } from "vitest";

import type {
  ToolCallSummary,
  TurnSummary,
} from "../../../main/core/agent/reflection-gate";
import { deepResearchAnswerReady } from "../runner";

const turn = (toolCalls: ToolCallSummary[], finalText = ""): TurnSummary => ({
  agentId: "a1",
  turnIndex: 0,
  finalText,
  toolCalls,
  endReason: "tool_calls",
});

const drCall = (
  directAnswer: string,
  confidence: string,
  success = true,
): ToolCallSummary => ({
  name: "deepResearch",
  success,
  result: { directAnswer, confidence, findings: "...", citations: [] },
});

describe("deepResearchAnswerReady", () => {
  it("high 置信 + 非空 directAnswer + 无 FINAL ANSWER → retry+forceNoTools，喂回具体答案", () => {
    const v = deepResearchAnswerReady(turn([drCall("egalitarian", "high")]));
    expect(v?.kind).toBe("retry");
    if (v?.kind === "retry") {
      expect(v.forceNoTools).toBe(true);
      expect(v.feedback).toContain("egalitarian");
      expect(v.feedback).toContain("FINAL ANSWER: egalitarian");
    }
  });

  it("medium 置信也触发", () => {
    const v = deepResearchAnswerReady(turn([drCall("Paris", "medium")]));
    expect(v?.kind).toBe("retry");
  });

  it("已有合格 FINAL ANSWER 时不干预（abstain）", () => {
    const v = deepResearchAnswerReady(
      turn([drCall("egalitarian", "high")], "...\nFINAL ANSWER: egalitarian"),
    );
    expect(v).toBeNull();
  });

  it("low/insufficient 置信不触发", () => {
    expect(deepResearchAnswerReady(turn([drCall("x", "low")]))).toBeNull();
    expect(
      deepResearchAnswerReady(turn([drCall("", "insufficient")])),
    ).toBeNull();
  });

  it("空 directAnswer 不触发", () => {
    expect(deepResearchAnswerReady(turn([drCall("", "high")]))).toBeNull();
  });

  it("没有 deepResearch 调用时不触发", () => {
    const v = deepResearchAnswerReady(
      turn([{ name: "webSearch", success: true, result: {} }]),
    );
    expect(v).toBeNull();
  });

  it("取本轮最后一个 high/medium directAnswer", () => {
    const v = deepResearchAnswerReady(
      turn([drCall("first", "high"), drCall("second", "high")]),
    );
    expect(v?.kind).toBe("retry");
    if (v?.kind === "retry") expect(v.feedback).toContain("second");
  });
});
