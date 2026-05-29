// 常驻会话列表(由原 SessionList 浮层提升到左栏)。从低频切片
// useChatSessionLite 取数据,流式期间不随 messages 重渲。
import { MessageSquarePlus, Trash2 } from "lucide-react";
import { useI18nContext } from "../../i18n/i18n-react";
import { useChatSessionLite } from "../chat/ChatSessionProvider";

export const ChatHistoryPanel = () => {
  const { LL } = useI18nContext();
  const chat = useChatSessionLite();

  return (
    <div className="flex h-full flex-col">
      <button
        type="button"
        onClick={chat.handleNewChat}
        disabled={chat.isLoading}
        className="mx-2 mt-2 flex items-center justify-center gap-1.5 rounded-md border border-dashed border-border px-3 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
      >
        <MessageSquarePlus className="size-4" />
        {LL.session_newChat()}
      </button>
      <div className="mt-2 flex-1 overflow-y-auto">
        {chat.sessions.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">
            {LL.session_empty()}
          </div>
        ) : (
          chat.sessions.map((s) => (
            <div
              key={s.id}
              className={`group flex cursor-pointer items-center gap-2 px-3 py-2.5 transition-colors hover:bg-accent ${
                s.id === chat.activeSessionId
                  ? "bg-accent shadow-[inset_2px_0_0_var(--color-primary)]"
                  : ""
              }`}
            >
              <button
                type="button"
                className="min-w-0 flex-1 text-left"
                onClick={() => chat.handleSelectSession(s.id)}
              >
                <div className="truncate text-sm text-foreground">
                  {s.title}
                </div>
                <div className="text-xs text-muted-foreground">
                  {new Date(s.updatedAt).toLocaleDateString()}
                </div>
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  chat.handleDeleteSession(s.id);
                }}
                className="p-1 text-muted-foreground opacity-0 transition-all hover:text-destructive group-hover:opacity-100"
                aria-label={LL.session_delete()}
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
};
