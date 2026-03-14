import { Trash2 } from "lucide-react";
import type { ChatSession } from "./types";

interface SessionListProps {
  sessions: ChatSession[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}

export const SessionList = ({
  sessions,
  activeId,
  onSelect,
  onDelete,
  onClose,
}: SessionListProps) => (
  <div className="absolute inset-0 z-10 bg-background/95 backdrop-blur-sm flex flex-col">
    <div className="flex items-center justify-between px-4 py-3 border-b border-border">
      <span className="text-sm font-medium text-foreground">历史对话</span>
      <button
        type="button"
        onClick={onClose}
        className="text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        关闭
      </button>
    </div>
    <div className="flex-1 overflow-y-auto">
      {sessions.length === 0 ? (
        <div className="px-4 py-8 text-center text-sm text-muted-foreground">暂无历史对话</div>
      ) : (
        sessions.map((s) => (
          <div
            key={s.id}
            className={`group flex items-center gap-2 px-4 py-2.5 cursor-pointer hover:bg-accent transition-colors ${
              s.id === activeId ? "bg-accent" : ""
            }`}
          >
            <button
              type="button"
              className="flex-1 text-left min-w-0"
              onClick={() => {
                onSelect(s.id);
                onClose();
              }}
            >
              <div className="text-sm text-foreground truncate">{s.title}</div>
              <div className="text-xs text-muted-foreground">
                {new Date(s.updatedAt).toLocaleDateString()}
              </div>
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onDelete(s.id);
              }}
              className="opacity-0 group-hover:opacity-100 p-1 text-muted-foreground hover:text-destructive transition-all"
              aria-label="删除对话"
            >
              <Trash2 className="size-3.5" />
            </button>
          </div>
        ))
      )}
    </div>
  </div>
);
