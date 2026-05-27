import { Bot, Brain, FileText, Loader2, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

interface WorkspaceMemoryInfo {
  agentMemory: string | null;
  agentMemoryPath: string;
  humanFile: string | null;
  humanContent: string | null;
  combined: string | null;
}

// 设置弹窗里的「Workspace Memory」面板:查看当前工作目录的记忆。
// 机器记忆(Agent 自写,存于 app data)可清空;人写的 AGENTS.md/CLAUDE.md 只读。
export const WorkspaceMemoryPanel = ({
  workspacePath,
}: {
  workspacePath?: string;
}) => {
  const [info, setInfo] = useState<WorkspaceMemoryInfo | null>(null);
  const [loading, setLoading] = useState(true);

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
    if (
      !window.confirm("清空该工作目录的机器记忆?(AGENTS.md 等人写文件不受影响)")
    )
      return;
    await window.filework.workspaceMemory.clear(workspacePath);
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

  const agentMemory = info?.agentMemory ?? null;
  const humanContent = info?.humanContent ?? null;

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

      {/* 机器记忆(Agent 自写,可清空) */}
      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-1.5 text-xs font-medium text-foreground">
            <Bot className="w-3.5 h-3.5 text-orange-400" />
            机器记忆 (Agent 自动维护)
          </span>
          {agentMemory && (
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
        <p className="text-[10px] text-muted-foreground break-all">
          {info?.agentMemoryPath}
        </p>
        {agentMemory ? (
          <pre className="text-[11px] whitespace-pre-wrap leading-relaxed max-h-64 overflow-y-auto rounded-md border border-border bg-muted px-3 py-2 text-muted-foreground">
            {agentMemory}
          </pre>
        ) : (
          <div className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
            暂无机器记忆 —— Agent 会在探索项目后自动写入
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
    </div>
  );
};
