// 右侧停靠区「回收站」面板:列出当前工作区被软删除的条目,支持恢复与永久清除。
import { RotateCcw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useI18nContext } from "../../i18n/i18n-react";

interface TrashEntry {
  id: string;
  originalPath: string;
  name: string;
  isDirectory: boolean;
  size: number;
  deletedAt: string;
}

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(1)} ${units[i]}`;
};

export const TrashPanel = ({
  workspaceRoot,
  active,
}: {
  workspaceRoot: string;
  /** 标签变为可见时刷新(Agent 可能在后台又删了文件)。 */
  active: boolean;
}) => {
  const { LL } = useI18nContext();
  const [entries, setEntries] = useState<TrashEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = useCallback(() => {
    window.filework
      .trashList(workspaceRoot)
      .then(setEntries)
      .catch(() => setEntries([]));
  }, [workspaceRoot]);

  useEffect(() => {
    if (active) refresh();
  }, [active, refresh]);

  const restore = async (id: string) => {
    setBusyId(id);
    setError(null);
    try {
      await window.filework.trashRestore(workspaceRoot, id);
      refresh();
    } catch (e) {
      setError(
        LL.trash_restoreFailed({
          reason: e instanceof Error ? e.message : String(e),
        }),
      );
    } finally {
      setBusyId(null);
    }
  };

  const deleteForever = async (id: string) => {
    setBusyId(id);
    try {
      await window.filework.trashEmpty(workspaceRoot, id);
      refresh();
    } finally {
      setBusyId(null);
    }
  };

  const emptyAll = async () => {
    if (!window.confirm(LL.trash_confirmEmptyAll())) return;
    await window.filework.trashEmpty(workspaceRoot);
    refresh();
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-end border-border border-b p-2">
        <button
          type="button"
          onClick={emptyAll}
          disabled={entries.length === 0}
          className="rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
        >
          {LL.trash_emptyAll()}
        </button>
      </div>

      {error && (
        <div className="border-destructive/30 border-b bg-destructive/10 px-3 py-1.5 text-[11px] text-destructive">
          {error}
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {entries.length === 0 ? (
          <div className="p-4 text-sm text-muted-foreground">
            {LL.trash_empty()}
          </div>
        ) : (
          <ul className="py-1">
            {entries.map((e) => (
              <li
                key={e.id}
                className="group flex items-center gap-2 px-3 py-1.5 hover:bg-accent"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-foreground">
                    {e.name}
                  </span>
                  <span
                    className="block truncate text-[11px] text-muted-foreground"
                    title={e.originalPath}
                  >
                    {e.originalPath}
                  </span>
                  <span className="block text-[10px] text-muted-foreground/70">
                    {LL.trash_deletedAt({
                      when: new Date(e.deletedAt).toLocaleString(),
                    })}
                    {" · "}
                    {formatBytes(e.size)}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => restore(e.id)}
                  disabled={busyId === e.id}
                  title={LL.trash_restore()}
                  aria-label={LL.trash_restore()}
                  className="rounded p-1 text-muted-foreground hover:bg-background hover:text-foreground disabled:opacity-40"
                >
                  <RotateCcw className="size-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => deleteForever(e.id)}
                  disabled={busyId === e.id}
                  title={LL.trash_deleteForever()}
                  aria-label={LL.trash_deleteForever()}
                  className="rounded p-1 text-muted-foreground hover:bg-background hover:text-destructive disabled:opacity-40"
                >
                  <Trash2 className="size-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};
