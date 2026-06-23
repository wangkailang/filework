import { describe, expect, it, vi } from "vitest";
import {
  completeGithubCopilotDeviceFlow,
  fetchGithubCopilotModels,
  startGithubCopilotDeviceFlow,
} from "../github-copilot-auth";

describe("github copilot device auth", () => {
  it("starts the GitHub device flow with the Copilot client id", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      return new Response(
        JSON.stringify({
          device_code: "device-123",
          user_code: "ABCD-1234",
          verification_uri: "https://github.com/login/device",
          expires_in: 900,
          interval: 5,
        }),
      );
    });

    const result = await startGithubCopilotDeviceFlow(fetchImpl);

    expect(result.userCode).toBe("ABCD-1234");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://github.com/login/device/code",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Accept: "application/json",
          "Content-Type": "application/json",
        }),
      }),
    );
    const request = fetchImpl.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(JSON.parse(String(request?.body))).toEqual({
      client_id: expect.any(String),
      scope: "read:user",
    });
  });

  it("exchanges the device code for durable GitHub auth and a Copilot session token", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "gho-test" })),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            token: "copilot-token",
            expires_at: 1_782_115_200,
            endpoints: { api: "https://api.githubcopilot.com" },
          }),
        ),
      );

    const result = await completeGithubCopilotDeviceFlow(
      { deviceCode: "device-123" },
      fetchImpl,
    );

    expect(result).toEqual({
      apiToken: "copilot-token",
      baseUrl: "https://api.githubcopilot.com",
      expiresAt: "2026-06-22T08:00:00.000Z",
      githubAccessToken: "gho-test",
    });
    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      "https://github.com/login/oauth/access_token",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      "https://api.github.com/copilot_internal/v2/token",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer gho-test",
        }),
      }),
    );
  });

  it("refreshes a Copilot session token with the durable GitHub access token", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            token: "fresh-copilot-token",
            expires_at: 1_782_115_800,
            endpoints: { api: "https://api.individual.githubcopilot.com" },
          }),
        ),
    );

    const { exchangeGithubCopilotSessionToken } = await import(
      "../github-copilot-auth"
    );
    const result = await exchangeGithubCopilotSessionToken(
      { githubAccessToken: "gho-test" },
      fetchImpl,
    );

    expect(result).toEqual({
      apiToken: "fresh-copilot-token",
      baseUrl: "https://api.individual.githubcopilot.com",
      expiresAt: "2026-06-22T08:10:00.000Z",
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.github.com/copilot_internal/v2/token",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer gho-test",
        }),
      }),
    );
  });

  it("fetches the current GitHub Copilot model list from the Copilot API", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              { id: "gpt-5.5", name: "GPT-5.5" },
              { id: "claude-sonnet-4.6" },
            ],
          }),
        ),
    );

    const result = await fetchGithubCopilotModels(
      {
        apiToken: "copilot-token",
        baseUrl: "https://api.githubcopilot.com",
      },
      fetchImpl,
    );

    expect(result).toEqual([
      {
        value: "gpt-5.5",
        label: "GPT-5.5",
        capabilities: {
          preferredApi: "responses",
          supportsReasoning: true,
          supportsTools: true,
          supportsVision: null,
        },
        contextWindow: null,
        maxOutputTokens: null,
      },
      {
        value: "claude-sonnet-4.6",
        label: "claude-sonnet-4.6",
        capabilities: {
          preferredApi: "chat_completions",
          supportsReasoning: false,
          supportsTools: true,
          supportsVision: null,
        },
        contextWindow: null,
        maxOutputTokens: null,
      },
    ]);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.githubcopilot.com/models",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Authorization: "Bearer copilot-token",
          "Copilot-Integration-Id": "vscode-chat",
        }),
      }),
    );
  });

  it("filters GitHub Copilot models that are not usable for chat", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              { id: "gpt-5.4-mini", name: "GPT-5.4 mini" },
              { id: "gpt-5.5", name: "GPT-5.5" },
              {
                id: "embedding-model",
                capabilities: { type: "embeddings" },
              },
              {
                id: "disabled-chat-model",
                model_picker_enabled: false,
              },
              { id: "claude-sonnet-4.6" },
            ],
          }),
        ),
    );

    const result = await fetchGithubCopilotModels(
      {
        apiToken: "copilot-token",
        baseUrl: "https://api.githubcopilot.com",
      },
      fetchImpl,
    );

    expect(result.map((model) => model.value)).toEqual([
      "gpt-5.5",
      "claude-sonnet-4.6",
    ]);
  });
});
