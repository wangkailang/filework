import {
  CheckCircle2,
  Copy,
  ExternalLink,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useI18nContext } from "../../i18n/i18n-react";
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

export interface LlmModelOption {
  value: string;
  label: string;
}

export function getVisibleLlmModelOptions(
  provider: Provider,
  refreshedOptions: LlmModelOption[],
  currentModel: string,
): LlmModelOption[] {
  if (provider !== "github-copilot") return [];
  const currentValue = currentModel.trim();
  if (!currentValue) return refreshedOptions;
  if (refreshedOptions.some((option) => option.value === currentValue)) {
    return refreshedOptions;
  }
  return [{ value: currentValue, label: currentValue }, ...refreshedOptions];
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
  const [copilotModelOptions, setCopilotModelOptions] = useState<
    LlmModelOption[]
  >([]);
  const [copilotModelBusy, setCopilotModelBusy] = useState(false);
  const [copilotModelError, setCopilotModelError] = useState<string | null>(
    null,
  );

  const loadGithubCopilotModels = useCallback(async (configId: string) => {
    setCopilotModelBusy(true);
    setCopilotModelError(null);
    try {
      const result =
        await window.filework.llmConfig.listGithubCopilotModels(configId);
      if ("error" in result) {
        setCopilotModelError(result.error);
        return;
      }
      setCopilotModelOptions(result);
      setForm((prev) =>
        prev.provider === "github-copilot" && !prev.model.trim() && result[0]
          ? { ...prev, model: result[0].value }
          : prev,
      );
    } catch (error) {
      setCopilotModelError(
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setCopilotModelBusy(false);
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
    setCopilotModelOptions([]);
    setCopilotModelBusy(false);
    setCopilotModelError(null);
  }, [open, editing]);

  const editingCopilotId =
    open && editing?.provider === "github-copilot" && copilotConnected
      ? editing.id
      : null;

  useEffect(() => {
    if (!editingCopilotId) return;
    void loadGithubCopilotModels(editingCopilotId);
  }, [editingCopilotId, loadGithubCopilotModels]);

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
            copilotModelOptions.length === 0
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
    setCopilotModelError(null);
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
      setCopilotModelOptions([]);
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
  const enabledInputId = "llm-config-enabled";

  const fieldPolicy = getLlmProviderFieldPolicy(form.provider);
  const selectedModelValue =
    form.model ||
    (form.provider === "github-copilot" ? GITHUB_COPILOT_DEFAULT_MODEL : "");
  const visibleModelOptions = getVisibleLlmModelOptions(
    form.provider,
    copilotModelOptions,
    selectedModelValue,
  );
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

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
    >
      <DialogContent className="flex! flex-col gap-0! overflow-hidden bg-background! p-0! text-foreground! shadow-2xl w-[480px]! max-w-[calc(100vw-32px)]! max-h-[calc(100vh-64px)]!">
        <div className="flex items-center border-b border-border px-5 py-3 pr-12">
          <DialogTitle className="text-sm font-medium text-foreground">
            {editing ? LL.llmConfig_edit() : LL.llmConfig_add()}
          </DialogTitle>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
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
                setCopilotModelOptions([]);
                setCopilotModelBusy(false);
                setCopilotModelError(null);
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
              {form.provider === "github-copilot" &&
                editing &&
                copilotConnected && (
                  <button
                    type="button"
                    onClick={() => void loadGithubCopilotModels(editing.id)}
                    disabled={copilotModelBusy}
                    title={LL.llmConfig_refreshModels()}
                    className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-wait disabled:opacity-60"
                  >
                    <RefreshCw
                      size={12}
                      className={copilotModelBusy ? "animate-spin" : undefined}
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
                    {option.label}
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
                    {option.label}
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
            {form.provider === "github-copilot" && copilotModelError && (
              <p className="mt-1 text-xs text-destructive">
                {copilotModelError}
              </p>
            )}
          </div>

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
            <div className="space-y-3 rounded-lg border border-border bg-muted/40 p-3">
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
            <div className="space-y-3 rounded-lg border border-border bg-muted/40 p-3">
              <div>
                <div className="text-sm font-medium text-foreground">
                  {LL.llmConfig_copilotTitle()}
                </div>
                <div className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  {LL.llmConfig_copilotDescription()}
                </div>
              </div>

              <div className="space-y-3">
                <div className="flex items-start gap-3">
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
                    1
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-foreground">
                      {LL.llmConfig_copilotStepGetCode()}
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {LL.llmConfig_copilotStepGetCodeHint()}
                    </div>
                    <button
                      type="button"
                      onClick={() => void handleStartCopilotAuth()}
                      disabled={copilotBusy !== null}
                      className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs text-primary-foreground hover:opacity-90 disabled:cursor-wait disabled:opacity-60"
                    >
                      {copilotBusy === "start" && (
                        <Loader2 size={13} className="animate-spin" />
                      )}
                      {LL.llmConfig_copilotGetCode()}
                    </button>
                  </div>
                </div>

                <div className="flex items-start gap-3">
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
                    2
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-foreground">
                      {LL.llmConfig_copilotStepCopyCode()}
                    </div>
                    <div className="mt-2 flex gap-2">
                      <div className="min-h-9 flex-1 rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm font-semibold text-foreground">
                        {copilotAuth?.userCode ||
                          LL.llmConfig_copilotCodePlaceholder()}
                      </div>
                      <button
                        type="button"
                        onClick={() =>
                          copilotAuth &&
                          void copyCopilotCode(copilotAuth.userCode)
                        }
                        disabled={!copilotAuth || copilotBusy !== null}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-2 text-xs text-foreground hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
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
                  </div>
                </div>

                <div className="flex items-start gap-3">
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
                    3
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-foreground">
                      {LL.llmConfig_copilotStepOpenPage()}
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {LL.llmConfig_copilotStepOpenPageHint()}
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void handleOpenCopilotAuth()}
                        disabled={!copilotAuth || copilotBusy !== null}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <ExternalLink size={13} />
                        {LL.llmConfig_copilotOpenPage()}
                      </button>
                      <span className="text-xs text-muted-foreground">
                        {GITHUB_DEVICE_LOGIN_URL}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="flex items-start gap-3">
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
                    4
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-foreground">
                      {LL.llmConfig_copilotStepComplete()}
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {LL.llmConfig_copilotStepCompleteHint()}
                    </div>
                    <button
                      type="button"
                      onClick={() => void handleCompleteCopilotAuth()}
                      disabled={!copilotAuth || copilotBusy !== null}
                      className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {copilotBusy === "complete" && (
                        <Loader2 size={13} className="animate-spin" />
                      )}
                      {LL.llmConfig_copilotConnect()}
                    </button>
                  </div>
                </div>
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
