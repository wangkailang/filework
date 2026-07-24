import {
  Bot,
  Brain,
  Check,
  FileText,
  Loader2,
  Pencil,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { ConfirmDialog } from "../ui/confirm-dialog";

type MemoryScope = "user" | "workspace";
type MemoryCategory = "preference" | "project" | "convention" | "reference";

interface MemoryEntry {
  key: string;
  category: MemoryCategory;
  text: string;
  updatedAt: string;
}

interface WorkspaceMemoryInfo {
  agentMemoryPath: string;
  userMemoryPath: string;
  workspaceEntries: MemoryEntry[];
  userEntries: MemoryEntry[];
  humanFile: string | null;
  humanContent: string | null;
  combined: string | null;
}

// 设置弹窗里的「Workspace Memory」面板:查看 / 逐条编辑删除当前工作目录的记忆。
// 机器记忆(Agent 自写,存于 app data)可清空;人写的 AGENTS.md/CLAUDE.md 只读。
export const WorkspaceMemoryPanel = ({
  workspacePath,
}: {
  workspacePath?: string;
}) => {
  const [info, setInfo] = useState<WorkspaceMemoryInfo | null>(null);
  const [loading, setLoading] = useState(true);
  // 正在编辑的条目标识 `${scope}:${key}` 与草稿文本(null 表示无编辑中)。
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [pendingClear, setPendingClear] = useState<"workspace" | "user" | null>(
    null,
  );
  const [clearBusy, setClearBusy] = useState(false);

  const load = useCallback(async () => {
    if (!workspacePath) {
      setInfo(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      setInfo(await window.filework.workspaceMemory.get(workspacePath));
    } catch {
      setInfo(null);
    } finally {
      setLoading(false);
    }
  }, [workspacePath]);

  useEffect(() => {
    load();
  }, [load]);

  const handleClear = async () => {
    if (!workspacePath) return;
    setPendingClear("workspace");
  };

  const handleClearUser = async () => {
    setPendingClear("user");
  };

  const handleConfirmClear = async () => {
    if (!pendingClear || !workspacePath) return;
    setClearBusy(true);
    try {
      if (pendingClear === "workspace") {
        await window.filework.workspaceMemory.clear(workspacePath);
      } else {
        await window.filework.workspaceMemory.clearUser();
      }
      setPendingClear(null);
      await load();
    } finally {
      setClearBusy(false);
    }
  };

  const handleDelete = async (scope: MemoryScope, key: string) => {
    if (!workspacePath) return;
    await window.filework.workspaceMemory.forget(workspacePath, scope, key);
    await load();
  };

  const handleSaveEdit = async (scope: MemoryScope, entry: MemoryEntry) => {
    if (!workspacePath) return;
    const text = draft.trim();
    setEditingId(null);
    if (!text || text === entry.text) return;
    await window.filework.workspaceMemory.update(
      workspacePath,
      scope,
      entry.key,
      entry.category,
      text,
    );
    await load();
  };

  if (!workspacePath) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
        <Brain className="w-8 h-8 mb-2 opacity-40" />
        <span className="text-sm">未打开工作目录</span>
        <span className="text-xs mt-1">打开一个目录后即可查看其记忆</span>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground">
        <Loader2 className="w-4 h-4 animate-spin mr-2" />
        <span className="text-sm">加载中…</span>
      </div>
    );
  }

  const userEntries = info?.userEntries ?? [];
  const workspaceEntries = info?.workspaceEntries ?? [];
  const humanContent = info?.humanContent ?? null;

  // 逐条渲染:展示 `[key] text`,hover 显示编辑/删除;编辑态用输入框就地改。
  const renderEntries = (entries: MemoryEntry[], scope: MemoryScope) => (
    <ul className="space-y-1 rounded-md border border-border bg-muted px-2 py-1.5">
      {entries.map((entry) => {
        const id = `${scope}:${entry.key}`;
        const editing = editingId === id;
        return (
          <li
            key={entry.key}
            className="group flex items-start gap-2 rounded px-1 py-1 hover:bg-accent/50"
          >
            {editing ? (
              <>
                <textarea
                  // biome-ignore lint/a11y/noAutofocus: 进入编辑态需立即聚焦
                  autoFocus
                  rows={2}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey))
                      handleSaveEdit(scope, entry);
                    else if (e.key === "Escape") setEditingId(null);
                  }}
                  className="min-w-0 flex-1 resize-none rounded border border-input bg-background px-1.5 py-1 text-[11px] text-foreground outline-none focus:border-primary"
                />
                <button
                  type="button"
                  onClick={() => handleSaveEdit(scope, entry)}
                  className="p-1 text-muted-foreground hover:text-primary"
                  title="保存 (⌘↵)"
                >
                  <Check className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => setEditingId(null)}
                  className="p-1 text-muted-foreground hover:text-destructive"
                  title="取消 (Esc)"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </>
            ) : (
              <>
                <span className="min-w-0 flex-1 text-[11px] leading-relaxed text-muted-foreground">
                  <span className="font-mono text-[10px] text-foreground/60">
                    [{entry.key}]
                  </span>{" "}
                  {entry.text}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setEditingId(id);
                    setDraft(entry.text);
                  }}
                  className="p-1 text-muted-foreground opacity-0 transition-[color,opacity] hover:text-foreground group-hover:opacity-100 group-focus-within:opacity-100"
                  title="编辑"
                >
                  <Pencil className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => handleDelete(scope, entry.key)}
                  className="p-1 text-muted-foreground opacity-0 transition-[color,opacity] hover:text-destructive group-hover:opacity-100 group-focus-within:opacity-100"
                  title="删除"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </>
            )}
          </li>
        );
      })}
    </ul>
  );

  return (
    <div className="space-y-5">
      {/* 当前工作目录路径 + 刷新 */}
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground break-all">
          {workspacePath}
        </p>
        <button
          type="button"
          onClick={load}
          className="shrink-0 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          title="刷新"
        >
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* 个人偏好记忆(user 作用域,跨所有工作区共享) */}
      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-1.5 text-xs font-medium text-foreground">
            <Brain className="w-3.5 h-3.5 text-purple-400" />
            个人偏好 (所有工作区通用)
          </span>
          {userEntries.length > 0 && (
            <button
              type="button"
              onClick={handleClearUser}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-red-400 transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5" />
              清空
            </button>
          )}
        </div>
        {userEntries.length > 0 ? (
          renderEntries(userEntries, "user")
        ) : (
          <div className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
            暂无个人偏好 —— 当你表达「以后都…」这类长期偏好时,Agent 会记到这里
          </div>
        )}
      </section>

      {/* 机器记忆(Agent 自写,可清空) */}
      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-1.5 text-xs font-medium text-foreground">
            <Bot className="w-3.5 h-3.5 text-orange-400" />
            项目记忆 (Agent 自动维护)
          </span>
          {workspaceEntries.length > 0 && (
            <button
              type="button"
              onClick={handleClear}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-red-400 transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5" />
              清空
            </button>
          )}
        </div>
        {info && (
          <button
            type="button"
            onClick={() => window.filework.showInFinder(info.agentMemoryPath)}
            title="在访达中显示该文件"
            className="block text-left text-[10px] text-muted-foreground hover:text-foreground hover:underline break-all transition-colors"
          >
            {info.agentMemoryPath}
          </button>
        )}
        {workspaceEntries.length > 0 ? (
          renderEntries(workspaceEntries, "workspace")
        ) : (
          <div className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
            暂无机器记忆 —— Agent
            在工作中学到可复用信息时会记录到这里;你也可以直接让它「记住…」
          </div>
        )}
      </section>

      {/* 人写指令(只读) */}
      <section className="space-y-2">
        <span className="flex items-center gap-1.5 text-xs font-medium text-foreground">
          <FileText className="w-3.5 h-3.5 text-blue-400" />
          项目指令 (只读)
        </span>
        {humanContent ? (
          <>
            <p className="text-[10px] text-muted-foreground">
              来源:{info?.humanFile}
            </p>
            <pre className="text-[11px] whitespace-pre-wrap leading-relaxed max-h-48 overflow-y-auto rounded-md border border-border bg-muted px-3 py-2 text-muted-foreground">
              {humanContent}
            </pre>
          </>
        ) : (
          <div className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
            未发现 AGENTS.md / CLAUDE.md
          </div>
        )}
      </section>

      <ConfirmDialog
        open={pendingClear !== null}
        title={
          pendingClear === "user"
            ? "清空跨工作区的个人偏好记忆?"
            : "清空该工作目录的机器记忆?"
        }
        description={
          pendingClear === "user"
            ? "只影响所有工作区通用的偏好,项目记忆不受影响。"
            : "AGENTS.md 等人写文件不受影响。"
        }
        confirmLabel="清空"
        cancelLabel="取消"
        destructive
        busy={clearBusy}
        onOpenChange={(open) => {
          if (!open) setPendingClear(null);
        }}
        onConfirm={handleConfirmClear}
      />
    </div>
  );
};
