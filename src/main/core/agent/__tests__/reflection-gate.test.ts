import type { LanguageModel } from "ai";
import { describe, expect, it, vi } from "vitest";

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return {
    ...actual,
    generateText: vi.fn(),
  };
});

import { generateText } from "ai";
import {
  builtinRules,
  createReflectionGate,
  defaultRules,
  emptyAssistantWithTools,
  missingFinalAnswer,
  pdfParseFailure,
  prematureConcession,
  type TurnSummary,
  toolDeniedSequence,
} from "../reflection-gate";

const mockedGenerate = vi.mocked(generateText);

const mkTurn = (overrides: Partial<TurnSummary> = {}): TurnSummary => ({
  agentId: "a1",
  turnIndex: 0,
  finalText: "",
  toolCalls: [],
  endReason: "stop",
  ...overrides,
});

describe("pdfParseFailure 规则", () => {
  it("工具名为 readPdf 失败时返回 retry（按工具名识别）", () => {
    const v = pdfParseFailure(
      mkTurn({
        toolCalls: [
          {
            name: "readPdf",
            success: false,
            result: { success: false, error: "bad header" },
          },
        ],
      }),
    );
    expect(v?.kind).toBe("retry");
  });

  it("错误信息明确提到 pdf 时返回 retry", () => {
    const v = pdfParseFailure(
      mkTurn({
        toolCalls: [
          {
            name: "fetchFile",
            success: false,
            result: { success: false, error: "PDF parse failed: bad header" },
          },
        ],
      }),
    );
    expect(v?.kind).toBe("retry");
  });

  it("通用解析错误（未提及 pdf）时弃权", () => {
    expect(
      pdfParseFailure(
        mkTurn({
          toolCalls: [
            {
              name: "fetchApi",
              success: false,
              result: { error: "Failed to parse JSON response" },
            },
          ],
        }),
      ),
    ).toBeNull();
  });

  it("CSV 解析错误（未提及 pdf）时弃权", () => {
    expect(
      pdfParseFailure(
        mkTurn({
          toolCalls: [
            {
              name: "loadCsv",
              success: false,
              result: { error: "Could not parse row 42" },
            },
          ],
        }),
      ),
    ).toBeNull();
  });

  it("仅文本声称解析失败、本轮无失败 PDF 工具调用时弃权（null）—— 下沉给 prematureConcession", () => {
    const v = pdfParseFailure(
      mkTurn({
        toolCalls: [],
        finalText: "抱歉，PDF 解析失败，请重新上传。",
      }),
    );
    expect(v).toBeNull();
  });

  it("完全与 PDF 无关时弃权（null）", () => {
    expect(pdfParseFailure(mkTurn({ finalText: "Hello, world." }))).toBeNull();
  });
});

describe("toolDeniedSequence 规则", () => {
  it("2 个及以上工具被拒时 abort", () => {
    const v = toolDeniedSequence(
      mkTurn({
        toolCalls: [
          { name: "rm", success: false, result: { denied: true } },
          { name: "rm", success: false, result: { denied: true } },
        ],
      }),
    );
    expect(v?.kind).toBe("abort");
  });

  it("仅 1 次拒绝时弃权", () => {
    expect(
      toolDeniedSequence(
        mkTurn({
          toolCalls: [{ name: "rm", success: false, result: { denied: true } }],
        }),
      ),
    ).toBeNull();
  });
});

describe("emptyAssistantWithTools 规则", () => {
  it("调用了工具却没有任何文本时 retry", () => {
    const v = emptyAssistantWithTools(
      mkTurn({
        toolCalls: [{ name: "x", success: true, result: { ok: true } }],
        finalText: "",
        endReason: "finish",
      }),
    );
    expect(v?.kind).toBe("retry");
  });

  it("endReason 为 tool_calls（模型仍在流程中）时弃权", () => {
    expect(
      emptyAssistantWithTools(
        mkTurn({
          toolCalls: [{ name: "x", success: true, result: {} }],
          finalText: "",
          endReason: "tool_calls",
        }),
      ),
    ).toBeNull();
  });
});

describe("missingFinalAnswer 规则（GAIA 选用）", () => {
  it("有叙述但缺 FINAL ANSWER 行时 retry", () => {
    const v = missingFinalAnswer(
      mkTurn({
        finalText:
          "Let me compute this analytically.\nI think the answer is around 3.",
        endReason: "stop",
      }),
    );
    expect(v?.kind).toBe("retry");
    if (v?.kind === "retry") {
      expect(v.feedback).toMatch(/FINAL ANSWER/);
    }
  });

  it("存在 FINAL ANSWER 行时弃权", () => {
    expect(
      missingFinalAnswer(
        mkTurn({
          finalText: "Some reasoning.\n\nFINAL ANSWER: 3",
          endReason: "stop",
        }),
      ),
    ).toBeNull();
  });

  it("接受短横线与小写变体", () => {
    expect(
      missingFinalAnswer(
        mkTurn({
          finalText: "final answer - 42",
          endReason: "stop",
        }),
      ),
    ).toBeNull();
    expect(
      missingFinalAnswer(
        mkTurn({
          finalText: "Final Answer: unknown",
          endReason: "stop",
        }),
      ),
    ).toBeNull();
  });

  it("FINAL ANSWER 后仅空白（无实际答案）时拒绝", () => {
    const v = missingFinalAnswer(
      mkTurn({
        finalText: "I tried hard.\nFINAL ANSWER:   ",
        endReason: "stop",
      }),
    );
    expect(v?.kind).toBe("retry");
  });

  it("endReason 为 tool_calls（步数预算在工具流程中耗尽）时以预算耗尽话术 retry", () => {
    // 在 gate 的调用点(callStreamText 之后),endReason=tool_calls
    // 表示模型仍在规划工具调用时,SDK 因 `stopWhen` 中止 —— 即步数预算耗尽。
    // 这正是我们想要 retry 而非跳过的场景。
    const v = missingFinalAnswer(
      mkTurn({
        finalText: "Let me try another tool.",
        endReason: "tool_calls",
      }),
    );
    expect(v?.kind).toBe("retry");
    if (v?.kind === "retry") {
      expect(v.feedback).toMatch(/budget/i);
      expect(v.forceNoTools).toBe(true);
    }
  });

  it("endReason 为 stop 且无 FINAL ANSWER 时以自然结束话术 retry", () => {
    const v = missingFinalAnswer(
      mkTurn({
        finalText: "Some reasoning but no sentinel.",
        endReason: "stop",
      }),
    );
    expect(v?.kind).toBe("retry");
    if (v?.kind === "retry") {
      // 自然结束话术应明确指向缺失的那一行,而非预算。
      expect(v.feedback).toMatch(/required `FINAL ANSWER/);
      expect(v.feedback).not.toMatch(/budget/i);
      expect(v.forceNoTools).toBe(true);
    }
  });

  it("finalText 为空时弃权（交由其他规则）", () => {
    expect(
      missingFinalAnswer(
        mkTurn({
          finalText: "",
          endReason: "stop",
        }),
      ),
    ).toBeNull();
  });
});

describe("prematureConcession 规则", () => {
  it("模型未升级就缴械时 retry", () => {
    const v = prematureConcession(
      mkTurn({
        toolCalls: [{ name: "webSearch", success: true, result: {} }],
        finalText:
          "这是一个超出当前工具能力的问题，我遇到了无法克服的技术限制。",
      }),
    );
    expect(v?.kind).toBe("retry");
    expect(v && "feedback" in v && v.feedback).toContain("Wayback");
  });

  it("仅声称 PDF 解析失败时 retry（由 pdfParseFailure 下沉）", () => {
    const v = prematureConcession(
      mkTurn({ finalText: "1959 年标准 PDF 无法解析，请重新上传。" }),
    );
    expect(v?.kind).toBe("retry");
  });

  it("本轮已用过升级层工具时弃权", () => {
    const v = prematureConcession(
      mkTurn({
        toolCalls: [{ name: "webScrape", success: false, result: {} }],
        finalText: "我尝试了多种方式，仍然遇到技术限制，无法完成该任务。",
      }),
    );
    expect(v).toBeNull();
  });

  it("文本已点名升级途径时弃权", () => {
    const v = prematureConcession(
      mkTurn({
        finalText:
          "我试过 webFetchRendered 和 Wayback 存档都取不到数据，确实存在技术限制。",
      }),
    );
    expect(v).toBeNull();
  });

  it("无放弃措辞的正常回答时弃权", () => {
    expect(
      prematureConcession(mkTurn({ finalText: "已完成，结果见上。" })),
    ).toBeNull();
  });
});

describe("builtinRules 顺序", () => {
  it("按优先级顺序包含全部规则", () => {
    const rules = builtinRules();
    expect(rules).toHaveLength(4);
    expect(rules[0]).toBe(pdfParseFailure);
    expect(rules[1]).toBe(toolDeniedSequence);
    expect(rules[2]).toBe(emptyAssistantWithTools);
    expect(rules[3]).toBe(prematureConcession);
  });
});

describe("defaultRules 规则集", () => {
  it("排除 emptyAssistantWithTools 以避免误报", () => {
    const rules = defaultRules();
    expect(rules).toHaveLength(3);
    expect(rules).toContain(pdfParseFailure);
    expect(rules).toContain(toolDeniedSequence);
    expect(rules).toContain(prematureConcession);
    expect(rules).not.toContain(emptyAssistantWithTools);
  });

  it("askClarification 后助手沉默时不 retry", async () => {
    // 最重要的误报场景:模型调用 askClarification,
    // 工具返回 {asked: true},模型合理地保持沉默以等待用户输入。
    // 默认规则集在此处绝不能强制 retry。
    const hook = createReflectionGate({ rules: defaultRules() });
    const v = await hook(
      mkTurn({
        toolCalls: [
          { name: "askClarification", success: true, result: { asked: true } },
        ],
        finalText: "",
        endReason: "stop",
      }),
    );
    expect(v.kind).toBe("continue");
  });

  it("默认路径（未传 model）不调用 LLM", async () => {
    mockedGenerate.mockReset();
    const hook = createReflectionGate({ rules: defaultRules() });
    const v = await hook(mkTurn({ finalText: "answer." }));
    expect(v.kind).toBe("continue");
    expect(mockedGenerate).not.toHaveBeenCalled();
  });

  it("readPdf 类工具失败时仍触发 pdfParseFailure", async () => {
    const hook = createReflectionGate({ rules: defaultRules() });
    const v = await hook(
      mkTurn({
        toolCalls: [
          {
            name: "readPdf",
            success: false,
            result: { error: "header malformed" },
          },
        ],
      }),
    );
    expect(v.kind).toBe("retry");
  });

  it("2 个及以上拒绝时仍触发 toolDeniedSequence", async () => {
    const hook = createReflectionGate({ rules: defaultRules() });
    const v = await hook(
      mkTurn({
        toolCalls: [
          { name: "rm", success: false, result: { denied: true } },
          { name: "rm", success: false, result: { denied: true } },
        ],
      }),
    );
    expect(v.kind).toBe("abort");
  });
});

describe("createReflectionGate", () => {
  it("返回首个非空规则裁决且不调用 LLM", async () => {
    mockedGenerate.mockReset();
    const fakeModel = {} as LanguageModel;
    const hook = createReflectionGate({ model: fakeModel });
    const v = await hook(
      mkTurn({
        toolCalls: [
          {
            name: "readPdf",
            success: false,
            result: { error: "pdf parse failed" },
          },
        ],
      }),
    );
    expect(v.kind).toBe("retry");
    expect(mockedGenerate).not.toHaveBeenCalled();
  });

  it("所有规则弃权且设置了 model 时回退调用 LLM", async () => {
    mockedGenerate.mockReset();
    mockedGenerate.mockResolvedValueOnce({
      text: '{"verdict":"retry","feedback":"add more detail"}',
    } as Awaited<ReturnType<typeof generateText>>);

    const fakeModel = {} as LanguageModel;
    const hook = createReflectionGate({ model: fakeModel });
    const v = await hook(mkTurn({ finalText: "k." }));
    expect(v.kind).toBe("retry");
    if (v.kind === "retry") expect(v.feedback).toBe("add more detail");
    expect(mockedGenerate).toHaveBeenCalledOnce();
  });

  it("llmFallback=false 时即便规则弃权也跳过 LLM", async () => {
    mockedGenerate.mockReset();
    const fakeModel = {} as LanguageModel;
    const hook = createReflectionGate({ model: fakeModel, llmFallback: false });
    const v = await hook(mkTurn({ finalText: "k." }));
    expect(v.kind).toBe("continue");
    expect(mockedGenerate).not.toHaveBeenCalled();
  });

  it("未提供 model 时跳过 LLM", async () => {
    mockedGenerate.mockReset();
    const hook = createReflectionGate({});
    const v = await hook(mkTurn({ finalText: "k." }));
    expect(v.kind).toBe("continue");
    expect(mockedGenerate).not.toHaveBeenCalled();
  });

  it("LLM 返回非法 JSON 时按 continue 处理", async () => {
    mockedGenerate.mockReset();
    mockedGenerate.mockResolvedValueOnce({
      text: "this is not json at all",
    } as Awaited<ReturnType<typeof generateText>>);

    const fakeModel = {} as LanguageModel;
    const hook = createReflectionGate({ model: fakeModel });
    const v = await hook(mkTurn({ finalText: "k." }));
    expect(v.kind).toBe("continue");
  });

  it("解析 ```json``` 围栏内的裁决", async () => {
    mockedGenerate.mockReset();
    mockedGenerate.mockResolvedValueOnce({
      text: '```json\n{"verdict":"abort","reason":"loop detected"}\n```',
    } as Awaited<ReturnType<typeof generateText>>);

    const fakeModel = {} as LanguageModel;
    const hook = createReflectionGate({ model: fakeModel });
    const v = await hook(mkTurn({ finalText: "k." }));
    expect(v.kind).toBe("abort");
    if (v.kind === "abort") expect(v.reason).toBe("loop detected");
  });

  it("LLM 调用抛错时返回 continue（非致命）", async () => {
    mockedGenerate.mockReset();
    mockedGenerate.mockRejectedValueOnce(new Error("rate limit"));

    const fakeModel = {} as LanguageModel;
    const hook = createReflectionGate({ model: fakeModel });
    const v = await hook(mkTurn({ finalText: "k." }));
    expect(v.kind).toBe("continue");
  });

  it("提供时使用自定义 llmPromptBuilder", async () => {
    mockedGenerate.mockReset();
    mockedGenerate.mockResolvedValueOnce({
      text: '{"verdict":"continue"}',
    } as Awaited<ReturnType<typeof generateText>>);

    const fakeModel = {} as LanguageModel;
    const builder = vi.fn((turn: TurnSummary) => `CUSTOM:${turn.finalText}`);
    const hook = createReflectionGate({
      model: fakeModel,
      llmPromptBuilder: builder,
    });
    await hook(mkTurn({ finalText: "answer-payload" }));

    expect(builder).toHaveBeenCalledOnce();
    expect(mockedGenerate).toHaveBeenCalledOnce();
    const call = mockedGenerate.mock.calls[0][0] as { prompt: string };
    expect(call.prompt).toBe("CUSTOM:answer-payload");
  });

  it("设置 llmForceNoTools 时给 LLM retry 裁决标记 forceNoTools", async () => {
    mockedGenerate.mockReset();
    mockedGenerate.mockResolvedValueOnce({
      text: '{"verdict":"retry","feedback":"fix unit"}',
    } as Awaited<ReturnType<typeof generateText>>);

    const fakeModel = {} as LanguageModel;
    const hook = createReflectionGate({
      model: fakeModel,
      llmForceNoTools: true,
    });
    const v = await hook(mkTurn({ finalText: "17000" }));
    expect(v.kind).toBe("retry");
    if (v.kind === "retry") {
      expect(v.feedback).toBe("fix unit");
      expect(v.forceNoTools).toBe(true);
    }
  });

  it("即便设置 llmForceNoTools，也不给 LLM continue 裁决标记 forceNoTools", async () => {
    mockedGenerate.mockReset();
    mockedGenerate.mockResolvedValueOnce({
      text: '{"verdict":"continue"}',
    } as Awaited<ReturnType<typeof generateText>>);

    const fakeModel = {} as LanguageModel;
    const hook = createReflectionGate({
      model: fakeModel,
      llmForceNoTools: true,
    });
    const v = await hook(mkTurn({ finalText: "ok" }));
    expect(v.kind).toBe("continue");
  });

  it("配置时把 llmTemperature 传给 generateText", async () => {
    mockedGenerate.mockReset();
    mockedGenerate.mockResolvedValueOnce({
      text: '{"verdict":"continue"}',
    } as Awaited<ReturnType<typeof generateText>>);

    const fakeModel = {} as LanguageModel;
    const hook = createReflectionGate({
      model: fakeModel,
      llmTemperature: 0,
    });
    await hook(mkTurn({ finalText: "ok" }));

    expect(mockedGenerate).toHaveBeenCalledOnce();
    const call = mockedGenerate.mock.calls[0][0] as { temperature?: number };
    expect(call.temperature).toBe(0);
  });

  it("未设置 llmTemperature 时省略 temperature", async () => {
    mockedGenerate.mockReset();
    mockedGenerate.mockResolvedValueOnce({
      text: '{"verdict":"continue"}',
    } as Awaited<ReturnType<typeof generateText>>);

    const fakeModel = {} as LanguageModel;
    const hook = createReflectionGate({ model: fakeModel });
    await hook(mkTurn({ finalText: "ok" }));

    const call = mockedGenerate.mock.calls[0][0] as Record<string, unknown>;
    expect("temperature" in call).toBe(false);
  });

  it("不给规则驱动的 retry 裁决标记 forceNoTools（仅 LLM 裁决）", async () => {
    // 某条确定性规则先触发 retry;由于未走 LLM 路径,
    // llmForceNoTools 不应改写该裁决。
    mockedGenerate.mockReset();
    const fakeModel = {} as LanguageModel;
    const hook = createReflectionGate({
      model: fakeModel,
      llmForceNoTools: true,
    });
    const v = await hook(
      mkTurn({
        toolCalls: [
          {
            name: "readPdf",
            success: false,
            result: { error: "pdf parse failed" },
          },
        ],
      }),
    );
    expect(v.kind).toBe("retry");
    if (v.kind === "retry") {
      // pdfParseFailure 规则不设置 forceNoTools,因此该标记必须
      // 保持未设置状态(undefined 或 false)。
      expect(v.forceNoTools).toBeUndefined();
    }
    expect(mockedGenerate).not.toHaveBeenCalled();
  });

  it("透传 abort 信号导致的失败", async () => {
    mockedGenerate.mockReset();
    const controller = new AbortController();
    controller.abort();
    mockedGenerate.mockRejectedValueOnce(
      Object.assign(new Error("aborted"), { name: "AbortError" }),
    );

    const fakeModel = {} as LanguageModel;
    const hook = createReflectionGate({ model: fakeModel });
    await expect(
      hook(mkTurn({ finalText: "k." }), controller.signal),
    ).rejects.toThrow();
  });
});
