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
  expires_at?: number;
  endpoints?: {
    api?: string;
  };
  error?: string;
  message?: string;
}

export interface GithubCopilotModelOption {
  capabilities: GithubCopilotModelCapabilities;
  contextWindow: number | null;
  value: string;
  label: string;
  maxOutputTokens: number | null;
}

export interface GithubCopilotModelCapabilities {
  preferredApi: "chat_completions" | "responses";
  supportsReasoning: boolean | null;
  supportsTools: boolean | null;
  supportsVision: boolean | null;
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
  expiresAt: string | null;
  githubAccessToken: string;
}

export interface GithubCopilotSessionToken {
  apiToken: string;
  baseUrl: string;
  expiresAt: string | null;
}

export interface GithubCopilotAuthMetadata {
  version: 1;
  githubAccessToken: string;
  copilotToken: string;
  copilotTokenExpiresAt: string | null;
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

function parseExpiresAt(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  const milliseconds = value > 10_000_000_000 ? value : value * 1000;
  return new Date(milliseconds).toISOString();
}

function readFinitePositiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

function readModelLimit(
  rawModel: Record<string, unknown>,
  keys: string[],
): number | null {
  for (const key of keys) {
    const value = readFinitePositiveNumber(rawModel[key]);
    if (value) return value;
  }
  const limit = rawModel.limit;
  if (isRecord(limit)) {
    for (const key of keys) {
      const value = readFinitePositiveNumber(limit[key]);
      if (value) return value;
    }
  }
  return null;
}

function isGithubCopilotChatModel(rawModel: Record<string, unknown>): boolean {
  if (rawModel.model_picker_enabled === false || rawModel.enabled === false) {
    return false;
  }

  const modelId = typeof rawModel.id === "string" ? rawModel.id.trim() : "";
  if (/^gpt-5\.\d+-mini$/i.test(modelId)) {
    return false;
  }

  const capabilities = isRecord(rawModel.capabilities)
    ? rawModel.capabilities
    : null;
  const type =
    typeof capabilities?.type === "string"
      ? capabilities.type.toLowerCase()
      : null;
  if (type && !["chat", "chat_completion", "chat_completions"].includes(type)) {
    return false;
  }

  const supportedEndpoints = [
    rawModel.supported_endpoints,
    rawModel.endpoints,
    capabilities?.supported_endpoints,
    capabilities?.endpoints,
  ].find((value): value is unknown[] => Array.isArray(value));
  if (supportedEndpoints) {
    const endpoints = supportedEndpoints
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.toLowerCase());
    if (
      endpoints.length > 0 &&
      !endpoints.some(
        (endpoint) =>
          endpoint.includes("chat") || endpoint.includes("response"),
      )
    ) {
      return false;
    }
  }

  return true;
}

function inferGithubCopilotModelCapabilities(
  modelId: string,
): GithubCopilotModelCapabilities {
  const lowerId = modelId.toLowerCase();
  const isGpt5 = lowerId.startsWith("gpt-5");
  const isMini = lowerId.includes("mini");
  const isReasoningModel =
    (isGpt5 && !isMini) ||
    lowerId.startsWith("o1") ||
    lowerId.startsWith("o3") ||
    lowerId.startsWith("o4") ||
    lowerId.startsWith("o5");

  return {
    preferredApi: isGpt5 && !isMini ? "responses" : "chat_completions",
    supportsReasoning: isReasoningModel,
    supportsTools: true,
    supportsVision:
      lowerId.includes("vision") ||
      lowerId.includes("gpt-4o") ||
      lowerId.includes("gemini")
        ? true
        : null,
  };
}

export function serializeGithubCopilotAuthMetadata(
  metadata: GithubCopilotAuthMetadata,
): string {
  return JSON.stringify(metadata);
}

export function parseGithubCopilotAuthMetadata(
  value: string | null | undefined,
): GithubCopilotAuthMetadata | null {
  if (!value?.trim()) return null;
  try {
    const parsed = JSON.parse(value) as Partial<GithubCopilotAuthMetadata>;
    if (
      parsed.version !== 1 ||
      typeof parsed.githubAccessToken !== "string" ||
      parsed.githubAccessToken.trim() === "" ||
      typeof parsed.copilotToken !== "string" ||
      parsed.copilotToken.trim() === "" ||
      typeof parsed.baseUrl !== "string" ||
      parsed.baseUrl.trim() === ""
    ) {
      return null;
    }
    return {
      version: 1,
      githubAccessToken: parsed.githubAccessToken,
      copilotToken: parsed.copilotToken,
      copilotTokenExpiresAt:
        typeof parsed.copilotTokenExpiresAt === "string"
          ? parsed.copilotTokenExpiresAt
          : null,
      baseUrl: parsed.baseUrl,
    };
  } catch {
    return null;
  }
}

export function shouldRefreshGithubCopilotSessionToken(
  metadata: Pick<GithubCopilotAuthMetadata, "copilotTokenExpiresAt">,
  nowMs = Date.now(),
): boolean {
  if (!metadata.copilotTokenExpiresAt) return true;
  const expiresAtMs = Date.parse(metadata.copilotTokenExpiresAt);
  if (!Number.isFinite(expiresAtMs)) return true;
  return expiresAtMs - nowMs <= 5 * 60 * 1000;
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
    if (!isGithubCopilotChatModel(rawModel)) continue;
    const value = rawModel.id.trim();
    if (!value || seen.has(value)) continue;
    const label =
      typeof rawModel.name === "string" && rawModel.name.trim()
        ? rawModel.name.trim()
        : value;
    seen.add(value);
    models.push({
      value,
      label,
      capabilities: inferGithubCopilotModelCapabilities(value),
      contextWindow: readModelLimit(rawModel, ["context", "context_window"]),
      maxOutputTokens: readModelLimit(rawModel, [
        "output",
        "max_output_tokens",
      ]),
    });
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

  const sessionToken = await exchangeGithubCopilotSessionToken(
    { githubAccessToken: tokenBody.access_token },
    fetchImpl,
  );

  return {
    ...sessionToken,
    githubAccessToken: tokenBody.access_token,
  };
}

export async function exchangeGithubCopilotSessionToken(
  input: { githubAccessToken: string },
  fetchImpl: FetchLike = defaultFetch(),
): Promise<GithubCopilotSessionToken> {
  const copilotResponse = await fetchImpl(GITHUB_COPILOT_TOKEN_URL, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${input.githubAccessToken}`,
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
    expiresAt: parseExpiresAt(copilotBody.expires_at),
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
