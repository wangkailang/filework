import { useState, useEffect, useCallback } from "react";
import { Plus, Pencil, Trash2, Star, StarOff } from "lucide-react";
import { useI18nContext } from "../../i18n/i18n-react";

type Provider = "openai" | "anthropic" | "deepseek" | "ollama" | "custom";

interface LlmConfig {
  id: string;
  name: string;
  provider: Provider;
  apiKey: string | null;
  baseUrl: string | null;
  model: string;
  isDefault: boolean;
}

interface FormData {
  name: string;
  provider: Provider;
  apiKey: string;
  baseUrl: string;
  model: string;
}

const EMPTY_FORM: FormData = { name: "", provider: "openai", apiKey: "", baseUrl: "", model: "" };

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

export const LlmConfigPanel = () => {
  const { LL } = useI18nContext();
  const [configs, setConfigs] = useState<LlmConfig[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormData>(EMPTY_FORM);
  const [errors, setErrors] = useState<Partial<Record<keyof FormData, string>>>({});
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  const loadConfigs = useCallback(async () => {
    const result = await window.filework.llmConfig.list();
    if (!("error" in result)) setConfigs(result as LlmConfig[]);
  }, []);

  useEffect(() => { loadConfigs(); }, [loadConfigs]);

  const validate = (): boolean => {
    const e: Partial<Record<keyof FormData, string>> = {};
    if (!form.name.trim()) e.name = LL.llmConfig_validationRequired();
    if (!form.model.trim()) e.model = LL.llmConfig_validationRequired();
    if (needsApiKey(form.provider) && !form.apiKey.trim()) e.apiKey = LL.llmConfig_validationRequired();
    if (needsBaseUrl(form.provider) && !form.baseUrl.trim()) e.baseUrl = LL.llmConfig_validationRequired();
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const handleSubmit = async () => {
    if (!validate()) return;
    if (editingId) {
      await window.filework.llmConfig.update(editingId, {
        name: form.name, provider: form.provider,
        apiKey: form.apiKey || undefined, baseUrl: form.baseUrl || undefined, model: form.model,
      });
    } else {
      await window.filework.llmConfig.create({
        name: form.name, provider: form.provider,
        apiKey: form.apiKey || undefined, baseUrl: form.baseUrl || undefined, model: form.model,
      });
    }
    setShowForm(false);
    setEditingId(null);
    setForm(EMPTY_FORM);
    loadConfigs();
  };

  const handleEdit = (c: LlmConfig) => {
    setForm({ name: c.name, provider: c.provider, apiKey: c.apiKey || "", baseUrl: c.baseUrl || "", model: c.model });
    setEditingId(c.id);
    setShowForm(true);
    setErrors({});
  };

  const handleDelete = async (id: string) => {
    const result = await window.filework.llmConfig.delete(id) as { error?: string; success?: boolean };
    if (result.error) alert(result.error);
    setDeleteConfirmId(null);
    loadConfigs();
  };

  const handleSetDefault = async (id: string) => {
    await window.filework.llmConfig.update(id, { isDefault: true });
    loadConfigs();
  };

  const openAdd = () => {
    setForm(EMPTY_FORM);
    setEditingId(null);
    setShowForm(true);
    setErrors({});
  };

  const inputCls = "w-full rounded-lg border border-border bg-background px-2 py-1.5 text-sm text-foreground focus:border-primary focus:outline-none";

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-foreground">{LL.llmConfig_title()}</h3>
        <button onClick={openAdd} className="flex items-center gap-1 text-xs text-primary hover:opacity-80">
          <Plus size={14} /> {LL.llmConfig_add()}
        </button>
      </div>

      {/* Config list */}
      <div className="space-y-2">
        {configs.map((c) => (
          <div key={c.id} className="flex items-center justify-between rounded-lg border border-border bg-muted px-3 py-2">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm text-foreground">{c.name}</span>
                {c.isDefault && (
                  <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[10px] text-primary">{LL.llmConfig_default()}</span>
                )}
              </div>
              <div className="text-xs text-muted-foreground">{c.provider} · {c.model}</div>
            </div>
            <div className="flex items-center gap-1">
              {!c.isDefault && (
                <button onClick={() => handleSetDefault(c.id)} className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-yellow-500" title={LL.llmConfig_setDefault()}>
                  <StarOff size={14} />
                </button>
              )}
              {c.isDefault && <Star size={14} className="mx-1 text-yellow-500" />}
              <button onClick={() => handleEdit(c)} className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground" title={LL.llmConfig_edit()}>
                <Pencil size={14} />
              </button>
              <button onClick={() => setDeleteConfirmId(c.id)} className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-destructive" title={LL.llmConfig_delete()}>
                <Trash2 size={14} />
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Delete confirmation */}
      {deleteConfirmId && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3">
          <p className="mb-2 text-sm text-foreground">{LL.llmConfig_deleteConfirm()}</p>
          <div className="flex gap-2">
            <button onClick={() => handleDelete(deleteConfirmId)} className="rounded-lg bg-destructive px-3 py-1 text-xs text-white hover:opacity-90">{LL.llmConfig_delete()}</button>
            <button onClick={() => setDeleteConfirmId(null)} className="rounded-lg bg-muted px-3 py-1 text-xs text-muted-foreground border border-border hover:bg-accent">{LL.llmConfig_cancel()}</button>
          </div>
        </div>
      )}

      {/* Add/Edit form */}
      {showForm && (
        <div className="space-y-3 rounded-lg border border-border bg-muted p-4">
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">{LL.llmConfig_name()}</label>
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={inputCls} />
            {errors.name && <p className="mt-1 text-xs text-destructive">{errors.name}</p>}
          </div>

          <div>
            <label className="mb-1 block text-xs text-muted-foreground">{LL.llmConfig_provider()}</label>
            <select value={form.provider} onChange={(e) => setForm({ ...form, provider: e.target.value as Provider, apiKey: "", baseUrl: "" })} className={inputCls}>
              {PROVIDERS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
            </select>
          </div>

          {needsApiKey(form.provider) && (
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">{LL.llmConfig_apiKey()}</label>
              <input type="password" value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} className={inputCls} />
              {errors.apiKey && <p className="mt-1 text-xs text-destructive">{errors.apiKey}</p>}
            </div>
          )}

          {(needsBaseUrl(form.provider) || form.provider === "openai" || form.provider === "anthropic" || form.provider === "deepseek") && (
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">
                {LL.llmConfig_baseUrl()} {!needsBaseUrl(form.provider) && <span className="opacity-50">(optional)</span>}
              </label>
              <input value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
                placeholder={form.provider === "ollama" ? "http://localhost:11434" : ""} className={inputCls} />
              {errors.baseUrl && <p className="mt-1 text-xs text-destructive">{errors.baseUrl}</p>}
            </div>
          )}

          <div>
            <label className="mb-1 block text-xs text-muted-foreground">{LL.llmConfig_model()}</label>
            <input value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} className={inputCls} />
            {errors.model && <p className="mt-1 text-xs text-destructive">{errors.model}</p>}
          </div>

          <div className="flex gap-2 pt-1">
            <button onClick={handleSubmit} className="rounded-lg bg-primary px-4 py-1.5 text-xs text-primary-foreground hover:opacity-90">{LL.llmConfig_save()}</button>
            <button onClick={() => { setShowForm(false); setEditingId(null); }} className="rounded-lg bg-muted px-4 py-1.5 text-xs text-muted-foreground border border-border hover:bg-accent">{LL.llmConfig_cancel()}</button>
          </div>
        </div>
      )}
    </div>
  );
};
