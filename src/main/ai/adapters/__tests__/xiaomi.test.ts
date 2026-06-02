import { describe, expect, it } from "vitest";
import { _internal } from "../xiaomi";

const { extractAssistantReasonings, patchOutgoingBody, reasoningStorage } =
  _internal;

describe("extractAssistantReasonings", () => {
  it("returns one entry per assistant message in prompt order", () => {
    const prompt = [
      { role: "system", content: "you are…" },
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "Thinking about greeting." },
          { type: "text", text: "Hello!" },
        ],
      },
      { role: "user", content: "do a thing" },
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "Need to call tool." },
          {
            type: "tool-call",
            toolCallId: "t1",
            toolName: "readFile",
            input: {},
          },
        ],
      },
    ];
    expect(extractAssistantReasonings(prompt)).toEqual([
      "Thinking about greeting.",
      "Need to call tool.",
    ]);
  });

  it("emits empty string for assistants with no reasoning part", () => {
    const prompt = [
      { role: "user", content: "x" },
      {
        role: "assistant",
        content: [{ type: "text", text: "plain reply" }],
      },
    ];
    expect(extractAssistantReasonings(prompt)).toEqual([""]);
  });

  it("concatenates multiple reasoning parts inside one assistant turn", () => {
    const prompt = [
      { role: "user", content: "x" },
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "first chunk. " },
          { type: "reasoning", text: "second chunk." },
          { type: "text", text: "answer" },
        ],
      },
    ];
    expect(extractAssistantReasonings(prompt)).toEqual([
      "first chunk. second chunk.",
    ]);
  });

  it("returns [] when the prompt has no assistant message", () => {
    expect(
      extractAssistantReasonings([
        { role: "system", content: "x" },
        { role: "user", content: "y" },
      ]),
    ).toEqual([]);
  });

  it("treats string-content assistant messages as zero reasoning", () => {
    const prompt = [
      { role: "user", content: "x" },
      { role: "assistant", content: "Plain string content." },
    ];
    expect(extractAssistantReasonings(prompt)).toEqual([""]);
  });
});

describe("patchOutgoingBody", () => {
  function runWithReasonings(reasonings: string[], fn: () => string): string {
    return reasoningStorage.run(reasonings, fn);
  }

  it("stamps reasoning_content on past assistant turns the deepseek converter blanked out", () => {
    // 模拟生产日志中的失败场景:到达 Xiaomi 的 2 个 assistant
    // 回合,在 deepseek 转换器执行 `index <= lastUserMessageIndex`
    // 丢弃后,两者的 reasoning_content 都为空。
    const body = JSON.stringify({
      model: "mimo-v2.5-pro",
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "u1" },
        { role: "assistant", content: "first reply" },
        { role: "user", content: "u2" },
        {
          role: "assistant",
          content: "second reply with tools",
          tool_calls: [
            {
              id: "t1",
              type: "function",
              function: { name: "x", arguments: "{}" },
            },
          ],
        },
        { role: "tool", tool_call_id: "t1", content: "result" },
        { role: "user", content: "u3 (current)" },
      ],
    });
    const patched = runWithReasonings(
      ["reasoning for turn 1", "reasoning for turn 2"],
      () => patchOutgoingBody(body),
    );
    const parsed = JSON.parse(patched);
    const assistantMsgs = parsed.messages.filter(
      (m: { role: string }) => m.role === "assistant",
    );
    expect(assistantMsgs).toHaveLength(2);
    expect(assistantMsgs[0].reasoning_content).toBe("reasoning for turn 1");
    expect(assistantMsgs[1].reasoning_content).toBe("reasoning for turn 2");
  });

  it("leaves the body untouched when no AsyncLocalStorage context is active", () => {
    const body = JSON.stringify({
      messages: [
        { role: "user", content: "u1" },
        { role: "assistant", content: "a1" },
      ],
    });
    expect(patchOutgoingBody(body)).toBe(body);
  });

  it("does not overwrite reasoning_content that deepseek already populated", () => {
    // deepseek 的转换器确实会为最新的 assistant 回合包含
    // reasoning_content —— 我们应保持原样,不要重复写入。
    const body = JSON.stringify({
      messages: [
        { role: "user", content: "u1" },
        {
          role: "assistant",
          content: "a1",
          reasoning_content: "deepseek-provided reasoning",
        },
      ],
    });
    const patched = runWithReasonings(["our-captured reasoning"], () =>
      patchOutgoingBody(body),
    );
    const parsed = JSON.parse(patched);
    expect(parsed.messages[1].reasoning_content).toBe(
      "deepseek-provided reasoning",
    );
  });

  it("skips assistant turns where we have no captured reasoning (empty string)", () => {
    const body = JSON.stringify({
      messages: [
        { role: "user", content: "u1" },
        { role: "assistant", content: "a1" },
        { role: "user", content: "u2" },
        { role: "assistant", content: "a2" },
      ],
    });
    const patched = runWithReasonings(["", "captured"], () =>
      patchOutgoingBody(body),
    );
    const parsed = JSON.parse(patched);
    expect(parsed.messages[1].reasoning_content).toBeUndefined();
    expect(parsed.messages[3].reasoning_content).toBe("captured");
  });

  it("returns the original string when the body isn't JSON", () => {
    expect(runWithReasonings(["x"], () => patchOutgoingBody("not-json"))).toBe(
      "not-json",
    );
  });

  it("returns the original string when reasonings is empty", () => {
    const body = JSON.stringify({
      messages: [
        { role: "user", content: "u" },
        { role: "assistant", content: "a" },
      ],
    });
    expect(runWithReasonings([], () => patchOutgoingBody(body))).toBe(body);
  });
});
