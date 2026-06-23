import { describe, expect, it } from "vitest";
import { classifyError } from "../error-classifier";

describe("classifyError", () => {
  it("turns GitHub Copilot quota exhaustion into a user-friendly non-retryable error", () => {
    const apiError = Object.assign(new Error("quota exceeded"), {
      name: "AI_APICallError",
      responseBody: "quota exceeded\n",
      responseHeaders: {
        "retry-after": "666518",
        "x-ratelimit-exceeded": "quota_exceeded",
        "x-ratelimit-quota-exceeded-retry-after": "666518",
        "x-ratelimit-user-retry-after": "666518",
      },
      statusCode: 429,
      url: "https://api.individual.githubcopilot.com/chat/completions",
    });
    const retryError = Object.assign(
      new Error("Failed after 3 attempts. Last error:"),
      {
        lastError: apiError,
        name: "AI_RetryError",
      },
    );

    const classified = classifyError(retryError);

    expect(classified.type).toBe("quota_exceeded");
    expect(classified.retryable).toBe(false);
    expect(classified.maxRetries).toBe(0);
    expect(classified.recoveryActions).toEqual(["settings"]);
    expect(classified.userMessage).toContain("GitHub Copilot");
    expect(classified.userMessage).toContain("额度已用尽");
    expect(classified.userMessage).toContain("7 天 17 小时");
    expect(classified.userMessage).not.toContain("Failed after 3 attempts");
  });

  it("keeps ordinary 429 errors retryable as transient rate limits", () => {
    const error = Object.assign(new Error("429 Too Many Requests"), {
      name: "AI_APICallError",
      responseBody: "rate limited",
      statusCode: 429,
    });

    const classified = classifyError(error);

    expect(classified.type).toBe("rate_limit");
    expect(classified.retryable).toBe(true);
    expect(classified.maxRetries).toBeGreaterThan(0);
  });

  it("turns unsupported model endpoint errors into a model-switch prompt", () => {
    const error = Object.assign(
      new Error(
        'model "gpt-5.4-mini" is not accessible via the /chat/completions endpoint',
      ),
      {
        name: "AI_APICallError",
        data: {
          error: {
            code: "unsupported_api_for_model",
            message:
              'model "gpt-5.4-mini" is not accessible via the /chat/completions endpoint',
          },
        },
        responseBody:
          '{"error":{"message":"model \\"gpt-5.4-mini\\" is not accessible via the /chat/completions endpoint","code":"unsupported_api_for_model"}}\n',
      },
    );

    const classified = classifyError(error);

    expect(classified.type).toBe("unsupported_model");
    expect(classified.retryable).toBe(false);
    expect(classified.maxRetries).toBe(0);
    expect(classified.recoveryActions).toEqual(["settings"]);
    expect(classified.userMessage).toContain("gpt-5.4-mini");
    expect(classified.userMessage).toContain("不支持当前接口");
    expect(classified.userMessage).not.toContain("APICallError");
  });
});
