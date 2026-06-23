import {
  CheckCircle2,
  Copy,
  ExternalLink,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { useI18nContext } from "../../i18n/i18n-react";
import { cn } from "../../lib/utils";
import { Dialog, DialogContent, DialogTitle } from "../ui/dialog";

export type Provider =
  | "openai"
  | "anthropic"
  | "deepseek"
  | "ollama"
  | "custom"
  | "minimax"
  | "xiaomi"
  | "github-copilot";

export type Modality = "chat" | "image" | "video";

export interface LlmConfig {
  id: string;
  name: string;
  provider: Provider;
  apiKey: string | null;
  baseUrl: string | null;
  apiPath: string | null;
  model: string;
  temperature: number | null;
  topP: number | null;
  maxOutputTokens: number | null;
  reasoningEffort: ReasoningEffort | null;
  modality: Modality;
  enabled: boolean;
  lastCheckedAt: string | null;
  lastCheckStatus: "success" | "error" | null;
  lastCheckMessage: string | null;
}

interface FormData {
  name: string;
  provider: Provider;
  apiKey: string;
  baseUrl: string;
  apiPath: string;
  model: string;
  temperature: string;
  topP: string;
  maxOutputTokens: string;
  reasoningEffort: "" | ReasoningEffort;
  modality: Modality;
  enabled: boolean;
}

const EMPTY_FORM: FormData = {
  name: "",
  provider: "openai",
  apiKey: "",
  baseUrl: "",
  apiPath: "",
  model: "",
  temperature: "",
  topP: "",
  maxOutputTokens: "",
  reasoningEffort: "",
  modality: "chat",
  enabled: true,
};

const PROVIDERS: { value: Provider; label: string }[] = [
  { value: "openai", label: "OpenAI" },
  { value: "anthropic", label: "Anthropic" },
  { value: "deepseek", label: "DeepSeek" },
  { value: "minimax", label: "MiniMax" },
  { value: "xiaomi", label: "Xiaomi MiMo" },
  { value: "github-copilot", label: "GitHub Copilot" },
  { value: "ollama", label: "Ollama" },
  { value: "custom", label: "OpenAI Compatible" },
];

const MODALITIES: { value: Modality; label: string }[] = [
  { value: "chat", label: "Chat" },
  { value: "image", label: "Image" },
  { value: "video", label: "Video" },
];

type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

const REASONING_EFFORTS: Array<"" | ReasoningEffort> = [
  "",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

function formatOptionalNumber(value: number | null | undefined): string {
  return value === null || value === undefined ? "" : String(value);
}

function parseOptionalNumber(value: string): number | null {
  const trimmed = value.trim();
  return trimmed ? Number(trimmed) : null;
}

export interface LlmModelOption {
  capabilities?: {
    preferredApi?: "chat_completions" | "responses" | null;
    supportsReasoning?: boolean | null;
    supportsTools?: boolean | null;
    supportsVision?: boolean | null;
  };
  contextWindow?: number | null;
  value: string;
  label: string;
  maxOutputTokens?: number | null;
}

function formatCompactTokenCount(value: number): string {
  if (value >= 1000 && value % 1000 === 0) {
    return `${value / 1000}k`;
  }
  if (value >= 1000) {
    return `${Math.round(value / 1000)}k`;
  }
  return String(value);
}

export function formatLlmModelOptionLabel(option: LlmModelOption): string {
  const hints: string[] = [];
  if (option.capabilities?.preferredApi === "responses") {
    hints.push("Responses");
  }
  if (option.capabilities?.supportsReasoning) {
    hints.push("Reasoning");
  }
  if (option.capabilities?.supportsTools) {
    hints.push("Tools");
  }
  if (option.capabilities?.supportsVision) {
    hints.push("Vision");
  }
  if (option.contextWindow) {
    hints.push(`${formatCompactTokenCount(option.contextWindow)} ctx`);
  }
  return [option.label, ...hints].join(" · ");
}

export function getVisibleLlmModelOptions(
  provider: Provider,
  refreshedOptions: LlmModelOption[],
  currentModel: string,
): LlmModelOption[] {
  if (provider !== "github-copilot" && provider !== "custom") return [];
  const currentValue = currentModel.trim();
  if (!currentValue) return refreshedOptions;
  if (refreshedOptions.some((option) => option.value === currentValue)) {
    return refreshedOptions;
  }
  return [{ value: currentValue, label: currentValue }, ...refreshedOptions];
}

export type LlmSelectedModelAvailability =
  | "available"
  | "unavailable"
  | "unknown";

export function getLlmSelectedModelAvailability(
  provider: Provider,
  refreshedOptions: LlmModelOption[],
  currentModel: string,
): LlmSelectedModelAvailability {
  if (provider !== "github-copilot" && provider !== "custom") return "unknown";
  if (refreshedOptions.length === 0) return "unknown";

  const currentValue = currentModel.trim();
  if (!currentValue) return "unknown";
  return refreshedOptions.some((option) => option.value === currentValue)
    ? "available"
    : "unavailable";
}

export type LlmReasoningEffortAvailability =
  | "supported"
  | "unsupported"
  | "unknown";

export function getLlmReasoningEffortAvailability(
  provider: Provider,
  refreshedOptions: LlmModelOption[],
  currentModel: string,
): LlmReasoningEffortAvailability {
  if (provider !== "github-copilot" && provider !== "custom") return "unknown";
  if (refreshedOptions.length === 0) return "unknown";

  const currentValue = currentModel.trim();
  if (!currentValue) return "unknown";
  const selected = refreshedOptions.find(
    (option) => option.value === currentValue,
  );
  if (!selected?.capabilities) return "unknown";
  return selected.capabilities.supportsReasoning === false
    ? "unsupported"
    : "supported";
}

export function shouldShowGithubCopilotAuthFlow(
  provider: Provider,
  isEditing: boolean,
  isConnected: boolean,
): boolean {
  return provider === "github-copilot" && (!isEditing || !isConnected);
}

export function shouldShowGithubCopilotDisconnect(
  provider: Provider,
  isEditing: boolean,
  isConnected: boolean,
): boolean {
  return provider === "github-copilot" && isEditing && isConnected;
}

export type GithubCopilotAuthStepState = "current" | "done" | "locked";

export function getGithubCopilotAuthStepStates(
  hasDeviceCode: boolean,
): GithubCopilotAuthStepState[] {
  return hasDeviceCode
    ? ["done", "current", "current", "current"]
    : ["current", "locked", "locked", "locked"];
}

export interface LlmProviderFieldPolicy {
  showApiKey: boolean;
  requireApiKey: boolean;
  showBaseUrl: boolean;
  requireBaseUrl: boolean;
  showApiPath: boolean;
  supportsImageVideo: boolean;
  baseUrlPlaceholder: string;
  apiPathPlaceholder: string;
}

export function getLlmProviderFieldPolicy(
  provider: Provider,
): LlmProviderFieldPolicy {
  const requireApiKey = [
    "openai",
    "anthropic",
    "deepseek",
    "minimax",
    "xiaomi",
  ].includes(provider);
  const requireBaseUrl = [
    "ollama",
    "custom",
    "xiaomi",
    "github-copilot",
  ].includes(provider);
  const showBaseUrl =
    requireBaseUrl ||
    ["openai", "anthropic", "deepseek", "minimax"].includes(provider);
  const showApiPath = provider === "custom" || provider === "github-copilot";
  const supportsImageVideo = provider === "minimax";
  const baseUrlPlaceholder =
    provider === "ollama"
      ? "http://localhost:11434"
      : provider === "minimax"
        ? "https://api.minimaxi.com/v1"
        : provider === "xiaomi"
          ? "https://example.xiaomi.com/v1"
          : provider === "github-copilot"
            ? "https://api.githubcopilot.com"
            : provider === "custom"
              ? "https://api.example.com/v1"
              : "";

  return {
    showApiKey:
      provider === "github-copilot"
        ? false
        : requireApiKey || provider === "custom",
    requireApiKey,
    showBaseUrl,
    requireBaseUrl,
    showApiPath,
    supportsImageVideo,
    baseUrlPlaceholder,
    apiPathPlaceholder: "/chat/completions",
  };
}

const GITHUB_COPILOT_DEFAULT_BASE_URL = "https://api.githubcopilot.com";
const GITHUB_COPILOT_DEFAULT_API_PATH = "/chat/completions";
const GITHUB_COPILOT_DEFAULT_MODEL = "gpt-5.5";
const GITHUB_DEVICE_LOGIN_URL = "https://github.com/login/device";

interface GithubCopilotAuthStart {
  deviceCode: string;
  expiresIn: number;
  interval: number;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
}

const stepBadgeClass: Record<GithubCopilotAuthStepState, string> = {
  current: "bg-primary text-primary-foreground",
  done: "bg-emerald-500 text-white",
  locked: "bg-muted text-muted-foreground ring-1 ring-border",
};

const GithubCopilotAuthStep = ({
  action,
  hint,
  index,
  state,
  title,
}: {
  action?: ReactNode;
  hint?: ReactNode;
  index: number;
  state: GithubCopilotAuthStepState;
  title: ReactNode;
}) => (
  <div className="grid gap-2 py-1 sm:grid-cols-[1.75rem_minmax(0,1fr)_auto] sm:items-center">
    <span
      className={cn(
        "flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
        stepBadgeClass[state],
      )}
    >
      {state === "done" ? <CheckCircle2 size={14} /> : index}
    </span>
    <div className="min-w-0">
      <div className="text-sm font-medium leading-tight text-foreground">
        {title}
      </div>
      {hint && (
        <div className="mt-0.5 text-xs leading-snug text-muted-foreground">
          {hint}
        </div>
      )}
    </div>
    {action && (
      <div className="min-w-0 sm:justify-self-end sm:[grid-column:auto] [grid-column:2/-1]">
        {action}
      </div>
    )}
  </div>
);

interface LlmConfigEditModalProps {
  open: boolean;
  editing: LlmConfig | null;
  onClose: () => void;
  onSaved: () => void;
}

export const LlmConfigEditModal = ({
  open,
  editing,
  onClose,
  onSaved,
}: LlmConfigEditModalProps) => {
  const { LL } = useI18nContext();
  const [form, setForm] = useState<FormData>(EMPTY_FORM);
  const [errors, setErrors] = useState<Partial<Record<keyof FormData, string>>>(
    {},
  );
  const [copilotAuth, setCopilotAuth] = useState<GithubCopilotAuthStart | null>(
    null,
  );
  const [copilotBusy, setCopilotBusy] = useState<
    "start" | "copy" | "open" | "complete" | "disconnect" | null
  >(null);
  const [copilotConnected, setCopilotConnected] = useState(false);
  const [copilotCopied, setCopilotCopied] = useState(false);
  const [copilotError, setCopilotError] = useState<string | null>(null);
  const [refreshedModelOptions, setRefreshedModelOptions] = useState<
    LlmModelOption[]
  >([]);
  const [modelRefreshBusy, setModelRefreshBusy] = useState(false);
  const [modelRefreshError, setModelRefreshError] = useState<string | null>(
    null,
  );

  const loadLlmModels = useCallback(async (configId: string) => {
    setModelRefreshBusy(true);
    setModelRefreshError(null);
    try {
      const result = await window.filework.llmConfig.listModels(configId);
      if ("error" in result) {
        setModelRefreshError(result.error);
        return;
      }
      setRefreshedModelOptions(result);
      setForm((prev) =>
        (prev.provider === "github-copilot" || prev.provider === "custom") &&
        !prev.model.trim() &&
        result[0]
          ? { ...prev, model: result[0].value }
          : prev,
      );
    } catch (error) {
      setModelRefreshError(
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setModelRefreshBusy(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    if (editing) {
      setForm({
        name: editing.name,
        provider: editing.provider,
        apiKey: editing.apiKey || "",
        baseUrl: editing.baseUrl || "",
        apiPath: editing.apiPath || "",
        model: editing.model,
        temperature: formatOptionalNumber(editing.temperature),
        topP: formatOptionalNumber(editing.topP),
        maxOutputTokens: formatOptionalNumber(editing.maxOutputTokens),
        reasoningEffort: editing.reasoningEffort ?? "",
        modality: editing.modality ?? "chat",
        enabled: editing.enabled !== false,
      });
    } else {
      setForm(EMPTY_FORM);
    }
    setErrors({});
    setCopilotAuth(null);
    setCopilotBusy(null);
    setCopilotConnected(
      editing?.provider === "github-copilot" && Boolean(editing.apiKey),
    );
    setCopilotCopied(false);
    setCopilotError(null);
    setRefreshedModelOptions([]);
    setModelRefreshBusy(false);
    setModelRefreshError(null);
  }, [open, editing]);

  const editingDiscoverableModelConfigId =
    open &&
    editing &&
    (editing.provider === "custom" ||
      (editing.provider === "github-copilot" && copilotConnected))
      ? editing.id
      : null;

  useEffect(() => {
    if (!editingDiscoverableModelConfigId) return;
    void loadLlmModels(editingDiscoverableModelConfigId);
  }, [editingDiscoverableModelConfigId, loadLlmModels]);

  const validate = (): boolean => {
    const e: Partial<Record<keyof FormData, string>> = {};
    const policy = getLlmProviderFieldPolicy(form.provider);
    if (!form.name.trim()) e.name = LL.llmConfig_validationRequired();
    if (!form.model.trim()) e.model = LL.llmConfig_validationRequired();
    if (policy.requireApiKey && !form.apiKey.trim())
      e.apiKey = LL.llmConfig_validationRequired();
    if (policy.requireBaseUrl && !form.baseUrl.trim())
      e.baseUrl = LL.llmConfig_validationRequired();
    if (policy.showApiPath && form.apiPath.trim()) {
      if (!form.apiPath.trim().startsWith("/")) {
        e.apiPath = LL.llmConfig_apiPathInvalid();
      } else if (
        !form.apiPath.trim().toLowerCase().endsWith("/chat/completions")
      ) {
        e.apiPath = LL.llmConfig_apiPathInvalid();
      }
    }
    if (
      getLlmSelectedModelAvailability(
        form.provider,
        refreshedModelOptions,
        form.model,
      ) === "unavailable"
    ) {
      e.model = LL.llmConfig_modelUnavailable();
    }
    const temperature = parseOptionalNumber(form.temperature);
    if (
      temperature !== null &&
      (!Number.isFinite(temperature) || temperature < 0 || temperature > 2)
    ) {
      e.temperature = LL.llmConfig_temperatureInvalid();
    }
    const topP = parseOptionalNumber(form.topP);
    if (topP !== null && (!Number.isFinite(topP) || topP < 0 || topP > 1)) {
      e.topP = LL.llmConfig_topPInvalid();
    }
    const maxOutputTokens = parseOptionalNumber(form.maxOutputTokens);
    if (
      maxOutputTokens !== null &&
      (!Number.isInteger(maxOutputTokens) || maxOutputTokens <= 0)
    ) {
      e.maxOutputTokens = LL.llmConfig_maxOutputTokensInvalid();
    }
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const handleSubmit = async () => {
    if (!validate()) return;
    const apiPathValue =
      fieldPolicy.showApiPath && form.apiPath.trim()
        ? form.apiPath.trim()
        : null;
    const payload = {
      name: form.name,
      provider: form.provider,
      apiKey: form.apiKey || undefined,
      baseUrl: form.baseUrl || undefined,
      apiPath: apiPathValue ?? undefined,
      model: form.model,
      temperature: parseOptionalNumber(form.temperature),
      topP: parseOptionalNumber(form.topP),
      maxOutputTokens: parseOptionalNumber(form.maxOutputTokens),
      reasoningEffort: form.reasoningEffort || null,
      modality: form.modality,
      enabled: form.enabled,
    };
    if (editing) {
      await window.filework.llmConfig.update(editing.id, {
        ...payload,
        apiPath: apiPathValue,
      });
    } else {
      await window.filework.llmConfig.create(payload);
    }
    onSaved();
    onClose();
  };

  const setGithubCopilotDefaults = (nextForm: FormData): FormData => ({
    ...nextForm,
    name: nextForm.name || "GitHub Copilot",
    baseUrl: nextForm.baseUrl || GITHUB_COPILOT_DEFAULT_BASE_URL,
    apiPath: nextForm.apiPath || GITHUB_COPILOT_DEFAULT_API_PATH,
    model: nextForm.model || GITHUB_COPILOT_DEFAULT_MODEL,
    modality: "chat",
  });

  const copyCopilotCode = async (code: string) => {
    setCopilotBusy("copy");
    setCopilotError(null);
    try {
      await navigator.clipboard.writeText(code);
      setCopilotCopied(true);
    } catch (error) {
      setCopilotError(error instanceof Error ? error.message : String(error));
    } finally {
      setCopilotBusy(null);
    }
  };

  const handleStartCopilotAuth = async () => {
    setCopilotBusy("start");
    setCopilotError(null);
    setCopilotCopied(false);
    try {
      const result =
        (await window.filework.llmConfig.startGithubCopilotAuth()) as
          | GithubCopilotAuthStart
          | { error: string };
      if ("error" in result) {
        setCopilotError(result.error);
        return;
      }
      setCopilotAuth(result);
      await copyCopilotCode(result.userCode);
    } finally {
      setCopilotBusy(null);
    }
  };

  const handleOpenCopilotAuth = async () => {
    const target =
      copilotAuth?.verificationUriComplete ||
      copilotAuth?.verificationUri ||
      GITHUB_DEVICE_LOGIN_URL;
    setCopilotBusy("open");
    setCopilotError(null);
    try {
      await window.filework.openExternal(target);
    } catch (error) {
      setCopilotError(error instanceof Error ? error.message : String(error));
    } finally {
      setCopilotBusy(null);
    }
  };

  const handleCompleteCopilotAuth = async () => {
    if (!copilotAuth) return;
    setCopilotBusy("complete");
    setCopilotError(null);
    try {
      const selectedModel = form.model.trim();
      const result = (await window.filework.llmConfig.completeGithubCopilotAuth(
        {
          deviceCode: copilotAuth.deviceCode,
          name: form.name || "GitHub Copilot",
          configId: editing && !copilotConnected ? editing.id : undefined,
          model:
            selectedModel === GITHUB_COPILOT_DEFAULT_MODEL &&
            refreshedModelOptions.length === 0
              ? undefined
              : selectedModel || undefined,
        },
      )) as LlmConfig | { error: string };
      if ("error" in result) {
        setCopilotError(result.error);
        return;
      }
      onSaved();
      onClose();
    } finally {
      setCopilotBusy(null);
    }
  };

  const handleDisconnectCopilot = async () => {
    if (!editing) return;
    setCopilotBusy("disconnect");
    setCopilotError(null);
    setModelRefreshError(null);
    try {
      const result = (await window.filework.llmConfig.disconnectGithubCopilot(
        editing.id,
      )) as LlmConfig | { error: string };
      if ("error" in result) {
        setCopilotError(result.error);
        return;
      }
      setCopilotConnected(false);
      setCopilotAuth(null);
      setCopilotCopied(false);
      setRefreshedModelOptions([]);
      setForm((prev) => ({
        ...prev,
        apiKey: "",
        enabled: false,
      }));
      onSaved();
    } catch (error) {
      setCopilotError(error instanceof Error ? error.message : String(error));
    } finally {
      setCopilotBusy(null);
    }
  };

  const inputCls =
    "w-full rounded-lg border border-border bg-background px-2 py-1.5 text-sm text-foreground focus:border-primary focus:outline-none";
  const nameInputId = "llm-config-name";
  const providerInputId = "llm-config-provider";
  const modalityInputId = "llm-config-modality";
  const apiKeyInputId = "llm-config-api-key";
  const baseUrlInputId = "llm-config-base-url";
  const apiPathInputId = "llm-config-api-path";
  const modelInputId = "llm-config-model";
  const temperatureInputId = "llm-config-temperature";
  const topPInputId = "llm-config-top-p";
  const maxOutputTokensInputId = "llm-config-max-output-tokens";
  const reasoningEffortInputId = "llm-config-reasoning-effort";
  const enabledInputId = "llm-config-enabled";

  const fieldPolicy = getLlmProviderFieldPolicy(form.provider);
  const selectedModelValue =
    form.model ||
    (form.provider === "github-copilot" ? GITHUB_COPILOT_DEFAULT_MODEL : "");
  const visibleModelOptions = getVisibleLlmModelOptions(
    form.provider,
    refreshedModelOptions,
    selectedModelValue,
  );
  const selectedModelAvailability = getLlmSelectedModelAvailability(
    form.provider,
    refreshedModelOptions,
    selectedModelValue,
  );
  const reasoningEffortAvailability = getLlmReasoningEffortAvailability(
    form.provider,
    refreshedModelOptions,
    selectedModelValue,
  );
  const reasoningEffortDisabled = reasoningEffortAvailability === "unsupported";
  const showCopilotAuthFlow = shouldShowGithubCopilotAuthFlow(
    form.provider,
    Boolean(editing),
    copilotConnected,
  );
  const showCopilotDisconnect = shouldShowGithubCopilotDisconnect(
    form.provider,
    Boolean(editing),
    copilotConnected,
  );
  const copilotStepStates = getGithubCopilotAuthStepStates(
    Boolean(copilotAuth),
  );
  const getReasoningEffortLabel = (value: "" | ReasoningEffort): string => {
    switch (value) {
      case "":
        return LL.llmConfig_providerDefault();
      case "none":
        return LL.llmConfig_reasoningEffortNone();
      case "minimal":
        return LL.llmConfig_reasoningEffortMinimal();
      case "low":
        return LL.llmConfig_reasoningEffortLow();
      case "medium":
        return LL.llmConfig_reasoningEffortMedium();
      case "high":
        return LL.llmConfig_reasoningEffortHigh();
      case "xhigh":
        return LL.llmConfig_reasoningEffortXHigh();
    }
  };

  useEffect(() => {
    if (!reasoningEffortDisabled || !form.reasoningEffort) return;
    setForm((prev) => ({ ...prev, reasoningEffort: "" }));
  }, [form.reasoningEffort, reasoningEffortDisabled]);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
    >
      <DialogContent className="flex! flex-col gap-0! overflow-hidden bg-background! p-0! text-foreground! shadow-2xl w-[560px]! max-w-[calc(100vw-32px)]! max-h-[calc(100vh-48px)]!">
        <div className="flex items-center border-b border-border px-5 py-3 pr-12">
          <DialogTitle className="text-sm font-medium text-foreground">
            {editing ? LL.llmConfig_edit() : LL.llmConfig_add()}
          </DialogTitle>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-3.5 pb-5 space-y-2.5">
          <div>
            <label
              htmlFor={nameInputId}
              className="mb-1 block text-xs text-muted-foreground"
            >
              {LL.llmConfig_name()}
            </label>
            <input
              id={nameInputId}
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className={inputCls}
            />
            {errors.name && (
              <p className="mt-1 text-xs text-destructive">{errors.name}</p>
            )}
          </div>

          <div>
            <label
              htmlFor={providerInputId}
              className="mb-1 block text-xs text-muted-foreground"
            >
              {LL.llmConfig_provider()}
            </label>
            <select
              id={providerInputId}
              value={form.provider}
              onChange={(e) => {
                const next = e.target.value as Provider;
                const nextForm: FormData = {
                  ...form,
                  provider: next,
                  apiKey: "",
                  baseUrl: "",
                  apiPath: "",
                  // Reset modality whenever the new provider can't do image/video.
                  modality: getLlmProviderFieldPolicy(next).supportsImageVideo
                    ? form.modality
                    : "chat",
                };
                setForm(
                  next === "github-copilot"
                    ? setGithubCopilotDefaults(nextForm)
                    : nextForm,
                );
                setCopilotAuth(null);
                setCopilotConnected(false);
                setCopilotCopied(false);
                setCopilotError(null);
                setRefreshedModelOptions([]);
                setModelRefreshBusy(false);
                setModelRefreshError(null);
              }}
              className={inputCls}
            >
              {PROVIDERS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>

          {fieldPolicy.supportsImageVideo && (
            <div>
              <label
                htmlFor={modalityInputId}
                className="mb-1 block text-xs text-muted-foreground"
              >
                Modality
              </label>
              <select
                id={modalityInputId}
                value={form.modality}
                onChange={(e) =>
                  setForm({ ...form, modality: e.target.value as Modality })
                }
                className={inputCls}
              >
                {MODALITIES.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>
          )}

          {fieldPolicy.showApiKey && (
            <div>
              <label
                htmlFor={apiKeyInputId}
                className="mb-1 block text-xs text-muted-foreground"
              >
                {LL.llmConfig_apiKey()}{" "}
                {!fieldPolicy.requireApiKey && (
                  <span className="opacity-50">(optional)</span>
                )}
              </label>
              <input
                id={apiKeyInputId}
                type="password"
                value={form.apiKey}
                onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
                className={inputCls}
              />
              {errors.apiKey && (
                <p className="mt-1 text-xs text-destructive">{errors.apiKey}</p>
              )}
            </div>
          )}

          {fieldPolicy.showBaseUrl && (
            <div>
              <label
                htmlFor={baseUrlInputId}
                className="mb-1 block text-xs text-muted-foreground"
              >
                {LL.llmConfig_baseUrl()}{" "}
                {!fieldPolicy.requireBaseUrl && (
                  <span className="opacity-50">(optional)</span>
                )}
              </label>
              <input
                id={baseUrlInputId}
                value={form.baseUrl}
                onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
                placeholder={fieldPolicy.baseUrlPlaceholder}
                readOnly={form.provider === "github-copilot"}
                className={inputCls}
              />
              {errors.baseUrl && (
                <p className="mt-1 text-xs text-destructive">
                  {errors.baseUrl}
                </p>
              )}
            </div>
          )}

          {fieldPolicy.showApiPath && (
            <div>
              <label
                htmlFor={apiPathInputId}
                className="mb-1 block text-xs text-muted-foreground"
              >
                {LL.llmConfig_apiPath()}{" "}
                <span className="opacity-50">({LL.llmConfig_optional()})</span>
              </label>
              <input
                id={apiPathInputId}
                value={form.apiPath}
                onChange={(e) => setForm({ ...form, apiPath: e.target.value })}
                placeholder={fieldPolicy.apiPathPlaceholder}
                readOnly={form.provider === "github-copilot"}
                className={inputCls}
              />
              {errors.apiPath && (
                <p className="mt-1 text-xs text-destructive">
                  {errors.apiPath}
                </p>
              )}
            </div>
          )}

          <div>
            <div className="mb-1 flex items-center justify-between gap-2">
              <label
                htmlFor={modelInputId}
                className="block text-xs text-muted-foreground"
              >
                {LL.llmConfig_model()}
              </label>
              {(form.provider === "custom" ||
                (form.provider === "github-copilot" && copilotConnected)) &&
                editing && (
                  <button
                    type="button"
                    onClick={() => void loadLlmModels(editing.id)}
                    disabled={modelRefreshBusy}
                    title={LL.llmConfig_refreshModels()}
                    className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-wait disabled:opacity-60"
                  >
                    <RefreshCw
                      size={12}
                      className={modelRefreshBusy ? "animate-spin" : undefined}
                    />
                    {LL.llmConfig_refreshModels()}
                  </button>
                )}
            </div>
            {form.provider === "github-copilot" ? (
              <select
                id={modelInputId}
                value={selectedModelValue}
                onChange={(e) => setForm({ ...form, model: e.target.value })}
                className={inputCls}
              >
                {visibleModelOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {formatLlmModelOptionLabel(option)}
                  </option>
                ))}
              </select>
            ) : visibleModelOptions.length > 0 ? (
              <select
                id={modelInputId}
                value={form.model}
                onChange={(e) => setForm({ ...form, model: e.target.value })}
                className={inputCls}
              >
                {visibleModelOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {formatLlmModelOptionLabel(option)}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id={modelInputId}
                value={form.model}
                onChange={(e) => setForm({ ...form, model: e.target.value })}
                className={inputCls}
              />
            )}
            {errors.model && (
              <p className="mt-1 text-xs text-destructive">{errors.model}</p>
            )}
            {(form.provider === "github-copilot" ||
              form.provider === "custom") &&
              selectedModelAvailability === "unavailable" &&
              !errors.model && (
                <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                  {LL.llmConfig_modelUnavailable()}
                </p>
              )}
            {(form.provider === "github-copilot" ||
              form.provider === "custom") &&
              modelRefreshError && (
                <p className="mt-1 text-xs text-destructive">
                  {modelRefreshError}
                </p>
              )}
          </div>

          <details className="rounded-lg border border-border bg-muted/20 px-3 py-2">
            <summary className="cursor-pointer select-none text-xs font-medium text-muted-foreground">
              {LL.llmConfig_advancedOptions()}
            </summary>
            <div className="mt-3 grid grid-cols-2 gap-2.5">
              <div>
                <label
                  htmlFor={temperatureInputId}
                  className="mb-1 block text-xs text-muted-foreground"
                >
                  {LL.llmConfig_temperature()}{" "}
                  <span className="opacity-50">
                    ({LL.llmConfig_optional()})
                  </span>
                </label>
                <input
                  id={temperatureInputId}
                  type="number"
                  min={0}
                  max={2}
                  step={0.1}
                  value={form.temperature}
                  onChange={(e) =>
                    setForm({ ...form, temperature: e.target.value })
                  }
                  placeholder={LL.llmConfig_providerDefault()}
                  className={inputCls}
                />
                {errors.temperature && (
                  <p className="mt-1 text-xs text-destructive">
                    {errors.temperature}
                  </p>
                )}
              </div>
              <div>
                <label
                  htmlFor={topPInputId}
                  className="mb-1 block text-xs text-muted-foreground"
                >
                  {LL.llmConfig_topP()}{" "}
                  <span className="opacity-50">
                    ({LL.llmConfig_optional()})
                  </span>
                </label>
                <input
                  id={topPInputId}
                  type="number"
                  min={0}
                  max={1}
                  step={0.05}
                  value={form.topP}
                  onChange={(e) => setForm({ ...form, topP: e.target.value })}
                  placeholder={LL.llmConfig_providerDefault()}
                  className={inputCls}
                />
                {errors.topP && (
                  <p className="mt-1 text-xs text-destructive">{errors.topP}</p>
                )}
              </div>
              <div>
                <label
                  htmlFor={maxOutputTokensInputId}
                  className="mb-1 block text-xs text-muted-foreground"
                >
                  {LL.llmConfig_maxOutputTokens()}{" "}
                  <span className="opacity-50">
                    ({LL.llmConfig_optional()})
                  </span>
                </label>
                <input
                  id={maxOutputTokensInputId}
                  type="number"
                  min={1}
                  step={1}
                  value={form.maxOutputTokens}
                  onChange={(e) =>
                    setForm({ ...form, maxOutputTokens: e.target.value })
                  }
                  placeholder={LL.llmConfig_providerDefault()}
                  className={inputCls}
                />
                {errors.maxOutputTokens && (
                  <p className="mt-1 text-xs text-destructive">
                    {errors.maxOutputTokens}
                  </p>
                )}
              </div>
              <div>
                <label
                  htmlFor={reasoningEffortInputId}
                  className="mb-1 block text-xs text-muted-foreground"
                >
                  {LL.llmConfig_reasoningEffort()}{" "}
                  <span className="opacity-50">
                    ({LL.llmConfig_optional()})
                  </span>
                </label>
                <select
                  id={reasoningEffortInputId}
                  value={form.reasoningEffort}
                  disabled={reasoningEffortDisabled}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      reasoningEffort: e.target.value as "" | ReasoningEffort,
                    })
                  }
                  className={`${inputCls} disabled:cursor-not-allowed disabled:opacity-60`}
                >
                  {REASONING_EFFORTS.map((value) => (
                    <option key={value || "default"} value={value}>
                      {getReasoningEffortLabel(value)}
                    </option>
                  ))}
                </select>
                {reasoningEffortDisabled && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {LL.llmConfig_reasoningEffortUnsupported()}
                  </p>
                )}
              </div>
            </div>
          </details>

          <label
            htmlFor={enabledInputId}
            className="flex items-center gap-2 text-xs text-muted-foreground"
          >
            <input
              id={enabledInputId}
              type="checkbox"
              checked={form.enabled}
              onChange={(e) =>
                setForm({ ...form, enabled: e.currentTarget.checked })
              }
              className="size-4 accent-primary"
            />
            {LL.llmConfig_enabled()}
          </label>

          {showCopilotDisconnect && (
            <div className="space-y-2.5 rounded-lg border border-border bg-muted/30 p-3">
              <div>
                <div className="text-sm font-medium text-foreground">
                  {LL.llmConfig_copilotConnectedTitle()}
                </div>
                <div className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  {LL.llmConfig_copilotConnectedDescription()}
                </div>
              </div>
              <button
                type="button"
                onClick={() => void handleDisconnectCopilot()}
                disabled={copilotBusy !== null}
                className="inline-flex items-center gap-1.5 rounded-lg border border-destructive/30 px-3 py-1.5 text-xs text-destructive hover:bg-destructive/10 disabled:cursor-wait disabled:opacity-60"
              >
                {copilotBusy === "disconnect" && (
                  <Loader2 size={13} className="animate-spin" />
                )}
                {LL.llmConfig_copilotDisconnect()}
              </button>
              {copilotError && (
                <p className="text-xs text-destructive">{copilotError}</p>
              )}
            </div>
          )}

          {showCopilotAuthFlow && (
            <div className="space-y-2.5 rounded-lg border border-border bg-muted/30 p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-foreground">
                    {LL.llmConfig_copilotTitle()}
                  </div>
                  <div className="mt-1 max-w-[52ch] text-xs leading-relaxed text-muted-foreground">
                    {LL.llmConfig_copilotDescription()}
                  </div>
                </div>
                <div className="rounded-md border border-border bg-background px-2 py-1 text-[11px] text-muted-foreground">
                  {GITHUB_DEVICE_LOGIN_URL}
                </div>
              </div>

              <div className="space-y-1.5">
                <GithubCopilotAuthStep
                  index={1}
                  state={copilotStepStates[0]}
                  title={LL.llmConfig_copilotStepGetCode()}
                  hint={LL.llmConfig_copilotStepGetCodeHint()}
                  action={
                    <button
                      type="button"
                      onClick={() => void handleStartCopilotAuth()}
                      disabled={copilotBusy !== null}
                      className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-xs text-primary-foreground hover:opacity-90 disabled:cursor-wait disabled:opacity-60"
                    >
                      {copilotBusy === "start" && (
                        <Loader2 size={13} className="animate-spin" />
                      )}
                      {LL.llmConfig_copilotGetCode()}
                    </button>
                  }
                />

                <GithubCopilotAuthStep
                  index={2}
                  state={copilotStepStates[1]}
                  title={LL.llmConfig_copilotStepCopyCode()}
                  action={
                    <div className="flex w-full min-w-0 gap-2 sm:w-[330px]">
                      <div className="flex h-8 min-w-0 flex-1 items-center rounded-lg border border-border bg-background px-3 font-mono text-sm font-semibold text-foreground">
                        <span className="truncate">
                          {copilotAuth?.userCode ||
                            LL.llmConfig_copilotCodePlaceholder()}
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() =>
                          copilotAuth &&
                          void copyCopilotCode(copilotAuth.userCode)
                        }
                        disabled={!copilotAuth || copilotBusy !== null}
                        className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 text-xs text-foreground hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {copilotCopied ? (
                          <CheckCircle2 size={14} />
                        ) : (
                          <Copy size={14} />
                        )}
                        {copilotCopied
                          ? LL.llmConfig_copilotCopied()
                          : LL.llmConfig_copilotCopy()}
                      </button>
                    </div>
                  }
                />

                <GithubCopilotAuthStep
                  index={3}
                  state={copilotStepStates[2]}
                  title={LL.llmConfig_copilotStepOpenPage()}
                  hint={LL.llmConfig_copilotStepOpenPageHint()}
                  action={
                    <button
                      type="button"
                      onClick={() => void handleOpenCopilotAuth()}
                      disabled={!copilotAuth || copilotBusy !== null}
                      className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-xs text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <ExternalLink size={13} />
                      {LL.llmConfig_copilotOpenPage()}
                    </button>
                  }
                />

                <GithubCopilotAuthStep
                  index={4}
                  state={copilotStepStates[3]}
                  title={LL.llmConfig_copilotStepComplete()}
                  hint={LL.llmConfig_copilotStepCompleteHint()}
                  action={
                    <button
                      type="button"
                      onClick={() => void handleCompleteCopilotAuth()}
                      disabled={!copilotAuth || copilotBusy !== null}
                      className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-xs text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {copilotBusy === "complete" && (
                        <Loader2 size={13} className="animate-spin" />
                      )}
                      {LL.llmConfig_copilotConnect()}
                    </button>
                  }
                />
              </div>

              {copilotError && (
                <p className="text-xs text-destructive">{copilotError}</p>
              )}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 px-5 py-3 border-t border-border bg-muted/30">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg bg-muted px-4 py-1.5 text-xs text-muted-foreground border border-border hover:bg-accent"
          >
            {LL.llmConfig_cancel()}
          </button>
          {!showCopilotAuthFlow && (
            <button
              type="button"
              onClick={handleSubmit}
              className="rounded-lg bg-primary px-4 py-1.5 text-xs text-primary-foreground hover:opacity-90"
            >
              {LL.llmConfig_save()}
            </button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};
