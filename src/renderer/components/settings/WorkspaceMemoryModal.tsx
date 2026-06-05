import { Bot, X } from "lucide-react";
import { useEffect } from "react";
import { WorkspaceMemoryPanel } from "./WorkspaceMemoryPanel";

// 工作目录记忆弹窗:从 chat 头部的 memory 图标打开,查看当前目录的记忆。
// 比放进全局设置更贴合「当前工作目录」这个上下文。
export const WorkspaceMemoryModal = ({
  open,
  onClose,
  workspacePath,
}: {
  open: boolean;
  onClose: () => void;
  workspacePath?: string;
}) => {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    if (open) window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-100 flex items-center justify-center">
      <button
        type="button"
        className="absolute inset-0 bg-black/50 cursor-default animate-in fade-in-0 duration-150"
        onClick={onClose}
        aria-label="Close workspace memory"
      />

      <div className="relative flex flex-col bg-background border border-border rounded-xl shadow-2xl overflow-hidden w-[640px] max-w-[calc(100vw-64px)] max-h-[80vh] animate-in fade-in-0 zoom-in-95 duration-150">
        <div className="flex items-center justify-between px-5 py-3 border-b border-border">
          <h2 className="flex items-center gap-2 text-sm font-medium text-foreground">
            <Bot className="w-4 h-4 text-orange-400" />
            Workspace Memory
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4">
          <WorkspaceMemoryPanel workspacePath={workspacePath} />
        </div>
      </div>
    </div>
  );
};
