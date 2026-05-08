import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { useI18nContext } from "../../i18n/i18n-react";

type Provider = "openai" | "anthropic" | "deepseek" | "ollama" | "custom";

export interface LlmConfig {
  id: string;
  name: string;
  provider: Provider;
  apiKey: string | null;
  baseUrl: string | null;
  model: string;
}

interface FormData {
  name: string;
  provider: Provider;
  apiKey: string;
  baseUrl: string;
  model: string;
}

const EMPTY_FORM: FormData = {
  name: "",
  provider: "openai",
  apiKey: "",
  baseUrl: "",
  model: "",
};

const PROVIDERS: { value: Provider; label: string }[] = [
  { value: "openai", label: "OpenAI" },
  { value: "anthropic", label: "Anthropic" },
  { value: "deepseek", label: "DeepSeek" },
  { value: "ollama", label: "Ollama" },
  { value: "custom", label: "Custom (OpenAI Compatible)" },
];

function needsApiKey(p: Provider) {
  return ["openai", "anthropic", "deepseek"].includes(p);
}
function needsBaseUrl(p: Provider) {
  return ["ollama", "custom"].includes(p);
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

  useEffect(() => {
    if (!open) return;
    if (editing) {
      setForm({
        name: editing.name,
        provider: editing.provider,
        apiKey: editing.apiKey || "",
        baseUrl: editing.baseUrl || "",
        model: editing.model,
      });
    } else {
      setForm(EMPTY_FORM);
    }
    setErrors({});
  }, [open, editing]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [open, onClose]);

  if (!open) return null;

  const validate = (): boolean => {
    const e: Partial<Record<keyof FormData, string>> = {};
    if (!form.name.trim()) e.name = LL.llmConfig_validationRequired();
    if (!form.model.trim()) e.model = LL.llmConfig_validationRequired();
    if (needsApiKey(form.provider) && !form.apiKey.trim())
      e.apiKey = LL.llmConfig_validationRequired();
    if (needsBaseUrl(form.provider) && !form.baseUrl.trim())
      e.baseUrl = LL.llmConfig_validationRequired();
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const handleSubmit = async () => {
    if (!validate()) return;
    const payload = {
      name: form.name,
      provider: form.provider,
      apiKey: form.apiKey || undefined,
      baseUrl: form.baseUrl || undefined,
      model: form.model,
    };
    if (editing) {
      await window.filework.llmConfig.update(editing.id, payload);
    } else {
      await window.filework.llmConfig.create(payload);
    }
    onSaved();
    onClose();
  };

  const inputCls =
    "w-full rounded-lg border border-border bg-background px-2 py-1.5 text-sm text-foreground focus:border-primary focus:outline-none";
  const nameInputId = "llm-config-name";
  const providerInputId = "llm-config-provider";
  const apiKeyInputId = "llm-config-api-key";
  const baseUrlInputId = "llm-config-base-url";
  const modelInputId = "llm-config-model";

  const showBaseUrl =
    needsBaseUrl(form.provider) ||
    form.provider === "openai" ||
    form.provider === "anthropic" ||
    form.provider === "deepseek";

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center">
      <button
        type="button"
        className="absolute inset-0 bg-black/60 cursor-default"
        onClick={onClose}
        aria-label="Close edit modal"
      />

      <div className="relative flex flex-col w-[480px] max-w-[calc(100vw-32px)] max-h-[calc(100vh-64px)] bg-background border border-border rounded-xl shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3 border-b border-border">
          <h3 className="text-sm font-medium text-foreground">
            {editing ? LL.llmConfig_edit() : LL.llmConfig_add()}
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          >
            <X className="w-3.5 h-3.5" />
          </button>
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
              onChange={(e) =>
                setForm({
                  ...form,
                  provider: e.target.value as Provider,
                  apiKey: "",
                  baseUrl: "",
                })
              }
              className={inputCls}
            >
              {PROVIDERS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>

          {needsApiKey(form.provider) && (
            <div>
              <label
                htmlFor={apiKeyInputId}
                className="mb-1 block text-xs text-muted-foreground"
              >
                {LL.llmConfig_apiKey()}
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

          {showBaseUrl && (
            <div>
              <label
                htmlFor={baseUrlInputId}
                className="mb-1 block text-xs text-muted-foreground"
              >
                {LL.llmConfig_baseUrl()}{" "}
                {!needsBaseUrl(form.provider) && (
                  <span className="opacity-50">(optional)</span>
                )}
              </label>
              <input
                id={baseUrlInputId}
                value={form.baseUrl}
                onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
                placeholder={
                  form.provider === "ollama" ? "http://localhost:11434" : ""
                }
                className={inputCls}
              />
              {errors.baseUrl && (
                <p className="mt-1 text-xs text-destructive">
                  {errors.baseUrl}
                </p>
              )}
            </div>
          )}

          <div>
            <label
              htmlFor={modelInputId}
              className="mb-1 block text-xs text-muted-foreground"
            >
              {LL.llmConfig_model()}
            </label>
            <input
              id={modelInputId}
              value={form.model}
              onChange={(e) => setForm({ ...form, model: e.target.value })}
              className={inputCls}
            />
            {errors.model && (
              <p className="mt-1 text-xs text-destructive">{errors.model}</p>
            )}
          </div>
        </div>

        <div className="flex justify-end gap-2 px-5 py-3 border-t border-border bg-muted/30">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg bg-muted px-4 py-1.5 text-xs text-muted-foreground border border-border hover:bg-accent"
          >
            {LL.llmConfig_cancel()}
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            className="rounded-lg bg-primary px-4 py-1.5 text-xs text-primary-foreground hover:opacity-90"
          >
            {LL.llmConfig_save()}
          </button>
        </div>
      </div>
    </div>
  );
};
