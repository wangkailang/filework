import { getProviderFetch } from "../ai/provider-fetch";

export const GITHUB_COPILOT_CLIENT_ID = "Iv1.b507a08c87ecfe98";
const GITHUB_DEVICE_CODE_URL = "https://github.com/login/device/code";
const GITHUB_ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_COPILOT_TOKEN_URL =
  "https://api.github.com/copilot_internal/v2/token";

type FetchLike = typeof fetch;

interface DeviceCodeResponse {
  device_code?: string;
  user_code?: string;
  verification_uri?: string;
  verification_uri_complete?: string;
  expires_in?: number;
  interval?: number;
  error?: string;
  error_description?: string;
}

interface AccessTokenResponse {
  access_token?: string;
  error?: string;
  error_description?: string;
}

interface CopilotTokenResponse {
  token?: string;
  endpoints?: {
    api?: string;
  };
  error?: string;
  message?: string;
}

export interface GithubCopilotModelOption {
  value: string;
  label: string;
}

export interface GithubCopilotDeviceFlowStart {
  deviceCode: string;
  expiresIn: number;
  interval: number;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
}

export interface GithubCopilotDeviceFlowComplete {
  apiToken: string;
  baseUrl: string;
}

function authError(message: string): Error {
  return new Error(message);
}

async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!text.trim()) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw authError(`Invalid JSON response: ${text.slice(0, 160)}`);
  }
}

function defaultFetch(): FetchLike {
  return getProviderFetch() as FetchLike;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getCopilotBaseUrl(baseUrl?: string | null): string {
  return (baseUrl?.trim() || "https://api.githubcopilot.com").replace(
    /\/+$/,
    "",
  );
}

function parseGithubCopilotModels(body: unknown): GithubCopilotModelOption[] {
  const rawModels = Array.isArray(body)
    ? body
    : isRecord(body) && Array.isArray(body.data)
      ? body.data
      : isRecord(body) && Array.isArray(body.models)
        ? body.models
        : [];
  const seen = new Set<string>();
  const models: GithubCopilotModelOption[] = [];

  for (const rawModel of rawModels) {
    if (!isRecord(rawModel) || typeof rawModel.id !== "string") continue;
    const value = rawModel.id.trim();
    if (!value || seen.has(value)) continue;
    const label =
      typeof rawModel.name === "string" && rawModel.name.trim()
        ? rawModel.name.trim()
        : value;
    seen.add(value);
    models.push({ value, label });
  }

  return models;
}

export async function startGithubCopilotDeviceFlow(
  fetchImpl: FetchLike = defaultFetch(),
): Promise<GithubCopilotDeviceFlowStart> {
  const response = await fetchImpl(GITHUB_DEVICE_CODE_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: GITHUB_COPILOT_CLIENT_ID,
      scope: "read:user",
    }),
  });
  const body = await readJson<DeviceCodeResponse>(response);
  if (!response.ok || body.error) {
    throw authError(
      body.error_description || body.error || `HTTP ${response.status}`,
    );
  }
  if (!body.device_code || !body.user_code || !body.verification_uri) {
    throw authError("GitHub device flow response is missing required fields");
  }

  return {
    deviceCode: body.device_code,
    userCode: body.user_code,
    verificationUri: body.verification_uri,
    verificationUriComplete: body.verification_uri_complete,
    expiresIn: body.expires_in ?? 900,
    interval: body.interval ?? 5,
  };
}

export async function completeGithubCopilotDeviceFlow(
  input: { deviceCode: string },
  fetchImpl: FetchLike = defaultFetch(),
): Promise<GithubCopilotDeviceFlowComplete> {
  const tokenResponse = await fetchImpl(GITHUB_ACCESS_TOKEN_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: GITHUB_COPILOT_CLIENT_ID,
      device_code: input.deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }),
  });
  const tokenBody = await readJson<AccessTokenResponse>(tokenResponse);
  if (!tokenResponse.ok || tokenBody.error) {
    throw authError(
      tokenBody.error_description ||
        tokenBody.error ||
        `HTTP ${tokenResponse.status}`,
    );
  }
  if (!tokenBody.access_token) {
    throw authError("GitHub authorization is not complete yet");
  }

  const copilotResponse = await fetchImpl(GITHUB_COPILOT_TOKEN_URL, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${tokenBody.access_token}`,
      "Editor-Version": "filework/0.1.0",
      "User-Agent": "Filework",
    },
  });
  const copilotBody = await readJson<CopilotTokenResponse>(copilotResponse);
  if (!copilotResponse.ok || copilotBody.error) {
    throw authError(
      copilotBody.message ||
        copilotBody.error ||
        `HTTP ${copilotResponse.status}`,
    );
  }
  if (!copilotBody.token) {
    throw authError("GitHub Copilot token response is missing token");
  }

  return {
    apiToken: copilotBody.token,
    baseUrl: copilotBody.endpoints?.api || "https://api.githubcopilot.com",
  };
}

export async function fetchGithubCopilotModels(
  input: { apiToken: string; baseUrl?: string | null },
  fetchImpl: FetchLike = defaultFetch(),
): Promise<GithubCopilotModelOption[]> {
  const response = await fetchImpl(
    `${getCopilotBaseUrl(input.baseUrl)}/models`,
    {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${input.apiToken}`,
        "Copilot-Integration-Id": "vscode-chat",
        "Editor-Version": "filework/0.1.0",
        "User-Agent": "Filework",
      },
    },
  );
  const body = await readJson<unknown>(response);
  if (!response.ok) {
    const message =
      isRecord(body) && typeof body.message === "string"
        ? body.message
        : `HTTP ${response.status}`;
    throw authError(message);
  }

  const models = parseGithubCopilotModels(body);
  if (models.length === 0) {
    throw authError("GitHub Copilot model response is missing models");
  }
  return models;
}
