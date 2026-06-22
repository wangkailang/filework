import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useI18nContext } from "../../i18n/i18n-react";
import { ConfirmDialog } from "../ui/confirm-dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import { type LlmConfig, LlmConfigEditModal } from "./LlmConfigEditModal";

type LlmConfigStatus = "success" | "error" | null;

export const LlmConfigStatusIndicator = ({
  busy,
  label,
  status,
}: {
  busy: boolean;
  label: string;
  status: LlmConfigStatus;
}) => {
  const icon = busy ? (
    <Loader2 size={13} className="animate-spin text-primary" />
  ) : status === "success" ? (
    <CheckCircle2 size={13} className="text-emerald-500" />
  ) : status === "error" ? (
    <AlertCircle size={13} className="text-destructive" />
  ) : (
    <span className="size-2 rounded-full bg-muted-foreground/40" />
  );

  return (
    <Tooltip>
      <TooltipTrigger
        aria-label={label}
        className="flex w-4 shrink-0 cursor-help appearance-none items-center justify-center border-0 bg-transparent p-0 outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        type="button"
      >
        {icon}
      </TooltipTrigger>
      <TooltipContent
        align="center"
        className="z-[100] max-w-[min(320px,calc(100vw-2rem))] whitespace-normal break-words leading-snug"
        collisionPadding={8}
        side="bottom"
        sideOffset={6}
      >
        {label}
      </TooltipContent>
    </Tooltip>
  );
};

export const LlmConfigPanel = () => {
  const { LL } = useI18nContext();
  const [configs, setConfigs] = useState<LlmConfig[]>([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<LlmConfig | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);

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
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      const result = (await window.filework.llmConfig.delete(id)) as {
        error?: string;
        success?: boolean;
      };
      if (result.error) {
        setDeleteError(result.error);
        return;
      }
      setDeleteConfirmId(null);
      loadConfigs();
    } finally {
      setDeleteBusy(false);
    }
  };

  const handleSetEnabled = async (id: string, enabled: boolean) => {
    setConfigs((prev) =>
      prev.map((config) =>
        config.id === id ? { ...config, enabled } : config,
      ),
    );
    const result = (await window.filework.llmConfig.update(id, {
      enabled,
    })) as { error?: string };
    if (result.error) {
      await loadConfigs();
    }
  };

  const handleTest = async (id: string) => {
    setTestingId(id);
    try {
      const result = (await window.filework.llmConfig.test(id)) as
        | LlmConfig
        | { error: string };
      if ("id" in result) {
        setConfigs((prev) =>
          prev.map((config) => (config.id === id ? result : config)),
        );
      }
    } finally {
      setTestingId(null);
    }
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
        {configs.map((c) => {
          const statusTitle =
            c.lastCheckMessage ??
            (c.lastCheckStatus === "success"
              ? LL.llmConfig_statusSuccess()
              : LL.llmConfig_statusUnchecked());
          return (
            <div
              key={c.id}
              className={`flex items-center justify-between rounded-lg border border-border bg-muted px-3 py-2 ${
                c.enabled === false ? "opacity-60" : ""
              }`}
            >
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <LlmConfigStatusIndicator
                  busy={testingId === c.id}
                  label={statusTitle}
                  status={c.lastCheckStatus}
                />
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
              </div>
              <div className="flex items-center gap-2">
                <label className="flex cursor-pointer items-center gap-1 text-[11px] text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={c.enabled !== false}
                    onChange={(e) =>
                      void handleSetEnabled(c.id, e.currentTarget.checked)
                    }
                    className="size-3 accent-primary"
                  />
                  {LL.llmConfig_enabled()}
                </label>
                <button
                  type="button"
                  onClick={() => void handleTest(c.id)}
                  disabled={testingId === c.id}
                  className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-wait disabled:opacity-60"
                  title={LL.llmConfig_test()}
                >
                  {testingId === c.id ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <RefreshCw size={14} />
                  )}
                </button>
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
                  onClick={() => {
                    setDeleteConfirmId(c.id);
                    setDeleteError(null);
                  }}
                  className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-destructive"
                  title={LL.llmConfig_delete()}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <LlmConfigEditModal
        open={modalOpen}
        editing={editing}
        onClose={() => setModalOpen(false)}
        onSaved={loadConfigs}
      />

      <ConfirmDialog
        open={deleteConfirmId !== null}
        title={LL.llmConfig_deleteConfirm()}
        description={deleteError ?? undefined}
        confirmLabel={LL.llmConfig_delete()}
        cancelLabel={LL.llmConfig_cancel()}
        destructive
        busy={deleteBusy}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteConfirmId(null);
            setDeleteError(null);
          }
        }}
        onConfirm={() => {
          if (deleteConfirmId) void handleDelete(deleteConfirmId);
        }}
      />
    </div>
  );
};
