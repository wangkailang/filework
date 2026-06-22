import { execFile } from "node:child_process";
import {
  getLlmConfig,
  getLlmConfigAuthMetadata,
  updateLlmConfigRuntimeAuth,
} from "../db";
import {
  exchangeGithubCopilotSessionToken,
  type GithubCopilotSessionToken,
  parseGithubCopilotAuthMetadata,
  serializeGithubCopilotAuthMetadata,
  shouldRefreshGithubCopilotSessionToken,
} from "./github-copilot-auth";

const RECONNECT_MESSAGE =
  "GitHub Copilot authorization expired. Please disconnect and reconnect GitHub Copilot.";
const GITHUB_ACCESS_TOKEN_ENV_KEYS = [
  "COPILOT_GITHUB_TOKEN",
  "GH_TOKEN",
  "GITHUB_TOKEN",
] as const;

function readGithubAccessTokenFromEnv(): string | null {
  for (const key of GITHUB_ACCESS_TOKEN_ENV_KEYS) {
    const value = process.env[key]?.trim();
    if (value) return value;
  }
  return null;
}

function readGithubAccessTokenFromGhCli(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "gh",
      ["auth", "token"],
      { timeout: 5000, windowsHide: true },
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        const token = String(stdout ?? "").trim();
        resolve(token || null);
      },
    );
  });
}

async function resolveFallbackGithubAccessToken(): Promise<string | null> {
  return readGithubAccessTokenFromEnv() ?? readGithubAccessTokenFromGhCli();
}

async function exchangeFallbackGithubAccessToken(input: {
  configId: string;
  githubAccessToken: string;
}): Promise<GithubCopilotSessionToken> {
  const sessionToken = await exchangeGithubCopilotSessionToken({
    githubAccessToken: input.githubAccessToken,
  });
  updateLlmConfigRuntimeAuth(input.configId, {
    apiKey: sessionToken.apiToken,
    baseUrl: sessionToken.baseUrl,
  });
  return sessionToken;
}

export async function getFreshGithubCopilotSessionToken(input: {
  configId: string;
  forceRefresh?: boolean;
}): Promise<GithubCopilotSessionToken> {
  const config = getLlmConfig(input.configId);
  if (!config) {
    throw new Error("Selected LLM configuration does not exist");
  }
  if (config.provider !== "github-copilot") {
    throw new Error("Selected LLM configuration is not GitHub Copilot");
  }

  const metadata = parseGithubCopilotAuthMetadata(
    getLlmConfigAuthMetadata(input.configId),
  );
  if (!metadata) {
    const githubAccessToken = await resolveFallbackGithubAccessToken();
    if (!githubAccessToken) {
      throw new Error(RECONNECT_MESSAGE);
    }
    return exchangeFallbackGithubAccessToken({
      configId: input.configId,
      githubAccessToken,
    });
  }

  if (
    !input.forceRefresh &&
    !shouldRefreshGithubCopilotSessionToken(metadata)
  ) {
    return {
      apiToken: metadata.copilotToken,
      baseUrl: metadata.baseUrl,
      expiresAt: metadata.copilotTokenExpiresAt,
    };
  }

  let sessionToken: GithubCopilotSessionToken;
  try {
    sessionToken = await exchangeGithubCopilotSessionToken({
      githubAccessToken: metadata.githubAccessToken,
    });
  } catch (error) {
    const githubAccessToken = await resolveFallbackGithubAccessToken();
    if (!githubAccessToken) {
      throw error;
    }
    return exchangeFallbackGithubAccessToken({
      configId: input.configId,
      githubAccessToken,
    });
  }
  const authMetadata = serializeGithubCopilotAuthMetadata({
    version: 1,
    githubAccessToken: metadata.githubAccessToken,
    copilotToken: sessionToken.apiToken,
    copilotTokenExpiresAt: sessionToken.expiresAt,
    baseUrl: sessionToken.baseUrl,
  });

  updateLlmConfigRuntimeAuth(input.configId, {
    apiKey: sessionToken.apiToken,
    authMetadata,
    baseUrl: sessionToken.baseUrl,
  });

  return sessionToken;
}
