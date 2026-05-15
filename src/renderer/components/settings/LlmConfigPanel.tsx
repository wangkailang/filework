import { Pencil, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useI18nContext } from "../../i18n/i18n-react";
import { type LlmConfig, LlmConfigEditModal } from "./LlmConfigEditModal";

export const LlmConfigPanel = () => {
  const { LL } = useI18nContext();
  const [configs, setConfigs] = useState<LlmConfig[]>([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<LlmConfig | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  const loadConfigs = useCallback(async () => {
    const result = await window.filework.llmConfig.list();
    if (!("error" in result)) setConfigs(result as LlmConfig[]);
  }, []);

  useEffect(() => {
    loadConfigs();
  }, [loadConfigs]);

  const handleEdit = (c: LlmConfig) => {
    setEditing(c);
    setModalOpen(true);
  };

  const handleAdd = () => {
    setEditing(null);
    setModalOpen(true);
  };

  const handleDelete = async (id: string) => {
    const result = (await window.filework.llmConfig.delete(id)) as {
      error?: string;
      success?: boolean;
    };
    if (result.error) alert(result.error);
    setDeleteConfirmId(null);
    loadConfigs();
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-foreground">
          {LL.llmConfig_title()}
        </h3>
        <button
          type="button"
          onClick={handleAdd}
          className="flex items-center gap-1 text-xs text-primary hover:opacity-80"
        >
          <Plus size={14} /> {LL.llmConfig_add()}
        </button>
      </div>

      {/* Config list */}
      <div className="space-y-2">
        {configs.map((c) => (
          <div
            key={c.id}
            className="flex items-center justify-between rounded-lg border border-border bg-muted px-3 py-2"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm text-foreground">
                  {c.name}
                </span>
                {c.modality && c.modality !== "chat" && (
                  <span className="shrink-0 rounded-full border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary">
                    {c.modality}
                  </span>
                )}
              </div>
              <div className="text-xs text-muted-foreground">
                {c.provider} · {c.model}
              </div>
            </div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => handleEdit(c)}
                className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                title={LL.llmConfig_edit()}
              >
                <Pencil size={14} />
              </button>
              <button
                type="button"
                onClick={() => setDeleteConfirmId(c.id)}
                className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-destructive"
                title={LL.llmConfig_delete()}
              >
                <Trash2 size={14} />
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Delete confirmation */}
      {deleteConfirmId && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3">
          <p className="mb-2 text-sm text-foreground">
            {LL.llmConfig_deleteConfirm()}
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => handleDelete(deleteConfirmId)}
              className="rounded-lg bg-destructive px-3 py-1 text-xs text-white hover:opacity-90"
            >
              {LL.llmConfig_delete()}
            </button>
            <button
              type="button"
              onClick={() => setDeleteConfirmId(null)}
              className="rounded-lg bg-muted px-3 py-1 text-xs text-muted-foreground border border-border hover:bg-accent"
            >
              {LL.llmConfig_cancel()}
            </button>
          </div>
        </div>
      )}

      <LlmConfigEditModal
        open={modalOpen}
        editing={editing}
        onClose={() => setModalOpen(false)}
        onSaved={loadConfigs}
      />
    </div>
  );
};
