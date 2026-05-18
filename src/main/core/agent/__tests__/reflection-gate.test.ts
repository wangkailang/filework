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

describe("pdfParseFailure rule", () => {
  it("returns retry when tool named readPdf fails (tool name signal)", () => {
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

  it("returns retry when error message explicitly mentions pdf", () => {
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

  it("abstains on generic parse errors that don't mention pdf", () => {
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

  it("abstains on CSV parse errors without pdf mention", () => {
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

  it("returns continue when assistant already acknowledged the failure", () => {
    const v = pdfParseFailure(
      mkTurn({
        toolCalls: [],
        finalText: "抱歉，PDF 解析失败，请重新上传。",
      }),
    );
    expect(v?.kind).toBe("continue");
  });

  it("abstains (null) when nothing PDF-related happened", () => {
    expect(pdfParseFailure(mkTurn({ finalText: "Hello, world." }))).toBeNull();
  });
});

describe("toolDeniedSequence rule", () => {
  it("aborts when 2+ tools were denied", () => {
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

  it("abstains for a single denial", () => {
    expect(
      toolDeniedSequence(
        mkTurn({
          toolCalls: [{ name: "rm", success: false, result: { denied: true } }],
        }),
      ),
    ).toBeNull();
  });
});

describe("emptyAssistantWithTools rule", () => {
  it("retries when tool calls were made but no text was produced", () => {
    const v = emptyAssistantWithTools(
      mkTurn({
        toolCalls: [{ name: "x", success: true, result: { ok: true } }],
        finalText: "",
        endReason: "finish",
      }),
    );
    expect(v?.kind).toBe("retry");
  });

  it("abstains when endReason is tool_calls (model is mid-flow)", () => {
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

describe("missingFinalAnswer rule (GAIA opt-in)", () => {
  it("retries when finalText has narration but no FINAL ANSWER line", () => {
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

  it("abstains when FINAL ANSWER line is present", () => {
    expect(
      missingFinalAnswer(
        mkTurn({
          finalText: "Some reasoning.\n\nFINAL ANSWER: 3",
          endReason: "stop",
        }),
      ),
    ).toBeNull();
  });

  it("accepts dash and lowercase variants", () => {
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

  it("rejects FINAL ANSWER followed by only whitespace (no actual answer)", () => {
    const v = missingFinalAnswer(
      mkTurn({
        finalText: "I tried hard.\nFINAL ANSWER:   ",
        endReason: "stop",
      }),
    );
    expect(v?.kind).toBe("retry");
  });

  it("retries with budget-exhausted wording when endReason is tool_calls (step budget cut off mid-tool-flow)", () => {
    // At the gate's call site (post-callStreamText), endReason=tool_calls
    // means the SDK halted `stopWhen` while the model was still planning
    // tool calls — i.e. budget exhausted. This is exactly when we want a
    // retry, not a skip.
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

  it("retries with natural-end wording when endReason is stop and no FINAL ANSWER", () => {
    const v = missingFinalAnswer(
      mkTurn({
        finalText: "Some reasoning but no sentinel.",
        endReason: "stop",
      }),
    );
    expect(v?.kind).toBe("retry");
    if (v?.kind === "retry") {
      // Natural-end wording explicitly references the missing line, not budget.
      expect(v.feedback).toMatch(/required `FINAL ANSWER/);
      expect(v.feedback).not.toMatch(/budget/i);
      expect(v.forceNoTools).toBe(true);
    }
  });

  it("abstains when finalText is empty (delegated to other rules)", () => {
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

describe("builtinRules ordering", () => {
  it("contains all three rules in priority order", () => {
    const rules = builtinRules();
    expect(rules).toHaveLength(3);
    expect(rules[0]).toBe(pdfParseFailure);
    expect(rules[1]).toBe(toolDeniedSequence);
    expect(rules[2]).toBe(emptyAssistantWithTools);
  });
});

describe("defaultRules", () => {
  it("excludes emptyAssistantWithTools to avoid false positives", () => {
    const rules = defaultRules();
    expect(rules).toHaveLength(2);
    expect(rules).toContain(pdfParseFailure);
    expect(rules).toContain(toolDeniedSequence);
    expect(rules).not.toContain(emptyAssistantWithTools);
  });

  it("does not retry when askClarification leaves the assistant silent", async () => {
    // The most important false-positive case: model calls askClarification,
    // tool returns {asked: true}, model legitimately stays silent waiting
    // for user input. Default rules must NOT force a retry here.
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

  it("does not call LLM on the default path (no model passed)", async () => {
    mockedGenerate.mockReset();
    const hook = createReflectionGate({ rules: defaultRules() });
    const v = await hook(mkTurn({ finalText: "answer." }));
    expect(v.kind).toBe("continue");
    expect(mockedGenerate).not.toHaveBeenCalled();
  });

  it("still fires pdfParseFailure when a readPdf-style tool fails", async () => {
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

  it("still fires toolDeniedSequence on 2+ denials", async () => {
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
  it("returns first non-null rule verdict without calling LLM", async () => {
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

  it("calls LLM fallback when all rules abstain and model is set", async () => {
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

  it("skips LLM when llmFallback=false even if rules abstain", async () => {
    mockedGenerate.mockReset();
    const fakeModel = {} as LanguageModel;
    const hook = createReflectionGate({ model: fakeModel, llmFallback: false });
    const v = await hook(mkTurn({ finalText: "k." }));
    expect(v.kind).toBe("continue");
    expect(mockedGenerate).not.toHaveBeenCalled();
  });

  it("skips LLM when no model is provided", async () => {
    mockedGenerate.mockReset();
    const hook = createReflectionGate({});
    const v = await hook(mkTurn({ finalText: "k." }));
    expect(v.kind).toBe("continue");
    expect(mockedGenerate).not.toHaveBeenCalled();
  });

  it("treats malformed LLM JSON as continue", async () => {
    mockedGenerate.mockReset();
    mockedGenerate.mockResolvedValueOnce({
      text: "this is not json at all",
    } as Awaited<ReturnType<typeof generateText>>);

    const fakeModel = {} as LanguageModel;
    const hook = createReflectionGate({ model: fakeModel });
    const v = await hook(mkTurn({ finalText: "k." }));
    expect(v.kind).toBe("continue");
  });

  it("parses fenced ```json``` verdicts", async () => {
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

  it("returns continue when LLM call throws (non-fatal)", async () => {
    mockedGenerate.mockReset();
    mockedGenerate.mockRejectedValueOnce(new Error("rate limit"));

    const fakeModel = {} as LanguageModel;
    const hook = createReflectionGate({ model: fakeModel });
    const v = await hook(mkTurn({ finalText: "k." }));
    expect(v.kind).toBe("continue");
  });

  it("uses a custom llmPromptBuilder when provided", async () => {
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

  it("stamps forceNoTools on LLM retry verdicts when llmForceNoTools is set", async () => {
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

  it("does NOT stamp forceNoTools on LLM continue verdicts even when llmForceNoTools is set", async () => {
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

  it("passes llmTemperature to generateText when configured", async () => {
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

  it("omits temperature when llmTemperature is unset", async () => {
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

  it("does NOT stamp forceNoTools on rule-driven retry verdicts (only LLM verdicts)", async () => {
    // A deterministic rule fires retry first; llmForceNoTools should not
    // mutate that verdict because the LLM path was not taken.
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
      // pdfParseFailure rule does not set forceNoTools, so the flag must
      // remain unset (undefined or false).
      expect(v.forceNoTools).toBeUndefined();
    }
    expect(mockedGenerate).not.toHaveBeenCalled();
  });

  it("propagates abort signal failures", async () => {
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
