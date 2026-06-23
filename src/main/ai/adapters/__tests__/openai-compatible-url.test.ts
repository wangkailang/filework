import { describe, expect, it } from "vitest";

import {
  resolveOpenAICompatibleBaseUrl,
  resolveOpenAICompatibleChatCompletionsUrl,
} from "../openai-compatible-url";

describe("OpenAI-compatible URL helpers", () => {
  it("uses API Path to derive the SDK base URL from a plain host", () => {
    expect(
      resolveOpenAICompatibleBaseUrl(
        "https://gateway.example.com",
        "/v1/chat/completions",
      ),
    ).toBe("https://gateway.example.com/v1");
  });

  it("does not duplicate the API Path prefix when Base URL already contains it", () => {
    expect(
      resolveOpenAICompatibleBaseUrl(
        "https://gateway.example.com/v1",
        "/v1/chat/completions",
      ),
    ).toBe("https://gateway.example.com/v1");
  });

  it("builds the chat completions URL from the normalized SDK base URL", () => {
    expect(
      resolveOpenAICompatibleChatCompletionsUrl(
        "https://gateway.example.com",
        "/v1/chat/completions",
      ),
    ).toBe("https://gateway.example.com/v1/chat/completions");
  });
});
