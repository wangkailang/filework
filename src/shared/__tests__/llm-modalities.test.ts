import { describe, expect, it } from "vitest";

import { getDisplayLlmConfigModality } from "../llm-modalities";

describe("getDisplayLlmConfigModality", () => {
  it("displays legacy OpenAI-compatible image models as image configs", () => {
    expect(
      getDisplayLlmConfigModality({
        provider: "custom",
        model: "gpt-image-2",
        modality: "chat",
      }),
    ).toBe("image");

    expect(
      getDisplayLlmConfigModality({
        provider: "openai",
        model: "dall-e-3",
        modality: "chat",
      }),
    ).toBe("image");
  });

  it("keeps explicit non-chat modalities and regular chat models unchanged", () => {
    expect(
      getDisplayLlmConfigModality({
        provider: "minimax",
        model: "MiniMax-Hailuo-02",
        modality: "video",
      }),
    ).toBe("video");

    expect(
      getDisplayLlmConfigModality({
        provider: "custom",
        model: "gpt-5.5",
        modality: "chat",
      }),
    ).toBe("chat");
  });
});
