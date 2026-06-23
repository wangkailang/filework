import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  getLlmConfig: vi.fn(),
  getLlmConfigAuthMetadata: vi.fn(),
  updateLlmConfigRuntimeAuth: vi.fn(),
}));

const authMock = vi.hoisted(() => ({
  exchangeGithubCopilotSessionToken: vi.fn(),
}));

const childProcessMock = vi.hoisted(() => ({
  execFile: vi.fn(),
}));

vi.mock("../../db", () => dbMock);

vi.mock("node:child_process", () => childProcessMock);

vi.mock("../github-copilot-auth", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../github-copilot-auth")>();
  return {
    ...actual,
    exchangeGithubCopilotSessionToken:
      authMock.exchangeGithubCopilotSessionToken,
  };
});

import { getFreshGithubCopilotSessionToken } from "../github-copilot-session";

const tokenEnvKeys = [
  "COPILOT_GITHUB_TOKEN",
  "GH_TOKEN",
  "GITHUB_TOKEN",
] as const;
const originalTokenEnv = Object.fromEntries(
  tokenEnvKeys.map((key) => [key, process.env[key]]),
);

const copilotConfig = {
  id: "copilot-1",
  name: "GitHub Copilot",
  provider: "github-copilot" as const,
  apiKey: "cached-session-token",
  baseUrl: "https://api.githubcopilot.com",
  apiPath: "/chat/completions",
  model: "gpt-5.5",
  modality: "chat" as const,
  isDefault: false,
  enabled: true,
  lastCheckedAt: null,
  lastCheckStatus: null,
  lastCheckMessage: null,
  createdAt: "2026-06-22T00:00:00.000Z",
  updatedAt: "2026-06-22T00:00:00.000Z",
};

describe("GitHub Copilot session token maintenance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-22T07:00:00.000Z"));
    dbMock.getLlmConfig.mockReturnValue(copilotConfig);
    for (const key of tokenEnvKeys) {
      delete process.env[key];
    }
    childProcessMock.execFile.mockImplementation(
      (
        _command: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout?: string) => void,
      ) => {
        callback(new Error("gh is not available"));
      },
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    for (const key of tokenEnvKeys) {
      const value = originalTokenEnv[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it("reuses a cached Copilot session token until it is close to expiry", async () => {
    dbMock.getLlmConfigAuthMetadata.mockReturnValue(
      JSON.stringify({
        version: 1,
        githubAccessToken: "gho-test",
        copilotToken: "cached-session-token",
        copilotTokenExpiresAt: "2026-06-22T08:00:00.000Z",
        baseUrl: "https://api.githubcopilot.com",
      }),
    );

    const result = await getFreshGithubCopilotSessionToken({
      configId: "copilot-1",
    });

    expect(result).toEqual({
      apiToken: "cached-session-token",
      baseUrl: "https://api.githubcopilot.com",
      expiresAt: "2026-06-22T08:00:00.000Z",
    });
    expect(authMock.exchangeGithubCopilotSessionToken).not.toHaveBeenCalled();
    expect(dbMock.updateLlmConfigRuntimeAuth).not.toHaveBeenCalled();
  });

  it("refreshes and persists Copilot session token when the cached one is stale", async () => {
    dbMock.getLlmConfigAuthMetadata.mockReturnValue(
      JSON.stringify({
        version: 1,
        githubAccessToken: "gho-test",
        copilotToken: "old-session-token",
        copilotTokenExpiresAt: "2026-06-22T07:03:00.000Z",
        baseUrl: "https://api.githubcopilot.com",
      }),
    );
    authMock.exchangeGithubCopilotSessionToken.mockResolvedValue({
      apiToken: "fresh-session-token",
      baseUrl: "https://api.individual.githubcopilot.com",
      expiresAt: "2026-06-22T08:00:00.000Z",
    });

    const result = await getFreshGithubCopilotSessionToken({
      configId: "copilot-1",
    });

    expect(result.apiToken).toBe("fresh-session-token");
    expect(authMock.exchangeGithubCopilotSessionToken).toHaveBeenCalledWith({
      githubAccessToken: "gho-test",
    });
    expect(dbMock.updateLlmConfigRuntimeAuth).toHaveBeenCalledWith(
      "copilot-1",
      {
        apiKey: "fresh-session-token",
        authMetadata: expect.stringContaining("fresh-session-token"),
        baseUrl: "https://api.individual.githubcopilot.com",
      },
    );
  });

  it("can force-refresh after Copilot rejects an otherwise cached token", async () => {
    dbMock.getLlmConfigAuthMetadata.mockReturnValue(
      JSON.stringify({
        version: 1,
        githubAccessToken: "gho-test",
        copilotToken: "cached-session-token",
        copilotTokenExpiresAt: "2026-06-22T08:00:00.000Z",
        baseUrl: "https://api.githubcopilot.com",
      }),
    );
    authMock.exchangeGithubCopilotSessionToken.mockResolvedValue({
      apiToken: "forced-session-token",
      baseUrl: "https://api.githubcopilot.com",
      expiresAt: "2026-06-22T08:00:00.000Z",
    });

    const result = await getFreshGithubCopilotSessionToken({
      configId: "copilot-1",
      forceRefresh: true,
    });

    expect(result.apiToken).toBe("forced-session-token");
    expect(authMock.exchangeGithubCopilotSessionToken).toHaveBeenCalledOnce();
  });

  it("asks the user to reconnect legacy configs that only stored a short-lived token", async () => {
    dbMock.getLlmConfigAuthMetadata.mockReturnValue(null);

    await expect(
      getFreshGithubCopilotSessionToken({ configId: "copilot-1" }),
    ).rejects.toThrow(/reconnect/i);
  });

  it("can recover a missing device-flow record from a GitHub token environment variable", async () => {
    dbMock.getLlmConfigAuthMetadata.mockReturnValue(null);
    process.env.COPILOT_GITHUB_TOKEN = "gho-env-token";
    authMock.exchangeGithubCopilotSessionToken.mockResolvedValue({
      apiToken: "env-session-token",
      baseUrl: "https://api.individual.githubcopilot.com",
      expiresAt: "2026-06-22T08:00:00.000Z",
    });

    const result = await getFreshGithubCopilotSessionToken({
      configId: "copilot-1",
    });

    expect(result.apiToken).toBe("env-session-token");
    expect(authMock.exchangeGithubCopilotSessionToken).toHaveBeenCalledWith({
      githubAccessToken: "gho-env-token",
    });
    expect(dbMock.updateLlmConfigRuntimeAuth).toHaveBeenCalledWith(
      "copilot-1",
      {
        apiKey: "env-session-token",
        baseUrl: "https://api.individual.githubcopilot.com",
      },
    );
  });

  it("can recover a missing device-flow record from gh auth token", async () => {
    dbMock.getLlmConfigAuthMetadata.mockReturnValue(null);
    childProcessMock.execFile.mockImplementation(
      (
        _command: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout?: string) => void,
      ) => {
        callback(null, "gho-cli-token\n");
      },
    );
    authMock.exchangeGithubCopilotSessionToken.mockResolvedValue({
      apiToken: "cli-session-token",
      baseUrl: "https://api.githubcopilot.com",
      expiresAt: null,
    });

    const result = await getFreshGithubCopilotSessionToken({
      configId: "copilot-1",
    });

    expect(result.apiToken).toBe("cli-session-token");
    expect(childProcessMock.execFile).toHaveBeenCalledWith(
      "gh",
      ["auth", "token"],
      { timeout: 5000, windowsHide: true },
      expect.any(Function),
    );
    expect(authMock.exchangeGithubCopilotSessionToken).toHaveBeenCalledWith({
      githubAccessToken: "gho-cli-token",
    });
  });
});
