// 常驻会话列表(由原 SessionList 浮层提升到左栏)。从低频切片
// useChatSessionLite 取数据,流式期间不随 messages 重渲。
// 列表按更新时间分段(今天/昨天/近 7 天/近 30 天/更早),每项显示
// 到分钟的时间戳,并支持双击或点铅笔图标就地重命名。
import { Check, Pencil, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useI18nContext } from "../../i18n/i18n-react";
import { useChatSessionLite } from "../chat/ChatSessionProvider";
import type { ChatSession } from "../chat/types";

type BucketKey = "today" | "yesterday" | "week" | "month" | "earlier";

const DAY_MS = 86_400_000;

// 按 updatedAt 落到对应分段(sessions 已由持久化层按时间倒序给出)。
function bucketOf(iso: string, startOfToday: number): BucketKey {
  const t = new Date(iso).getTime();
  if (t >= startOfToday) return "today";
  if (t >= startOfToday - DAY_MS) return "yesterday";
  if (t >= startOfToday - 7 * DAY_MS) return "week";
  if (t >= startOfToday - 30 * DAY_MS) return "month";
  return "earlier";
}

// 今天/昨天只显示时分,更久的补上日期(按当前语言本地化,中/日为
// "6月1日",英文为 "Jun 1")。
function formatStamp(iso: string, bucket: BucketKey, locale: string): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString(locale, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  if (bucket === "today" || bucket === "yesterday") return time;
  const date = d.toLocaleDateString(locale, {
    month: "short",
    day: "numeric",
  });
  return `${date} ${time}`;
}

export const ChatHistoryPanel = () => {
  const { LL, locale } = useI18nContext();
  const chat = useChatSessionLite();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  // 待二次确认删除的会话(null 表示无弹框)。
  const [pendingDelete, setPendingDelete] = useState<ChatSession | null>(null);

  const groups = useMemo(() => {
    const now = new Date();
    const startOfToday = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
    ).getTime();
    const order: BucketKey[] = [
      "today",
      "yesterday",
      "week",
      "month",
      "earlier",
    ];
    const map = new Map<BucketKey, ChatSession[]>();
    for (const s of chat.sessions) {
      const k = bucketOf(s.updatedAt, startOfToday);
      const arr = map.get(k);
      if (arr) arr.push(s);
      else map.set(k, [s]);
    }
    return order
      .map((key) => ({ key, items: map.get(key) ?? [] }))
      .filter((g) => g.items.length > 0);
  }, [chat.sessions]);

  const groupLabel: Record<BucketKey, () => string> = {
    today: LL.session_group_today,
    yesterday: LL.session_group_yesterday,
    week: LL.session_group_week,
    month: LL.session_group_month,
    earlier: LL.session_group_earlier,
  };

  const startRename = (s: ChatSession) => {
    setEditingId(s.id);
    setDraft(s.title);
  };

  const commitRename = (id: string) => {
    if (editingId !== id) return;
    chat.handleRenameSession(id, draft);
    setEditingId(null);
  };

  const cancelRename = () => setEditingId(null);

  // 删除确认弹框开启时,Esc 关闭。
  useEffect(() => {
    if (!pendingDelete) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPendingDelete(null);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [pendingDelete]);

  return (
    <div className="flex h-full flex-col">
      <div className="mt-2 flex-1 overflow-y-auto">
        {chat.sessions.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">
            {LL.session_empty()}
          </div>
        ) : (
          groups.map((group) => (
            <div key={group.key}>
              <div className="sticky top-0 z-10 bg-background/95 px-3 py-1 text-xs font-medium text-muted-foreground backdrop-blur">
                {groupLabel[group.key]()}
              </div>
              {group.items.map((s) => {
                const isEditing = editingId === s.id;
                return (
                  <div
                    key={s.id}
                    className={`group flex cursor-pointer items-center gap-2 px-3 py-2.5 transition-colors hover:bg-accent ${
                      s.id === chat.activeSessionId
                        ? "bg-accent shadow-[inset_2px_0_0_var(--color-primary)]"
                        : ""
                    }`}
                  >
                    {isEditing ? (
                      <div className="min-w-0 flex-1">
                        <input
                          // biome-ignore lint/a11y/noAutofocus: 进入编辑态需立即聚焦
                          autoFocus
                          value={draft}
                          onChange={(e) => setDraft(e.target.value)}
                          onClick={(e) => e.stopPropagation()}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") commitRename(s.id);
                            else if (e.key === "Escape") cancelRename();
                          }}
                          onBlur={() => commitRename(s.id)}
                          className="w-full rounded border border-input bg-background px-1.5 py-0.5 text-sm text-foreground outline-none focus:border-primary"
                        />
                        <div className="mt-0.5 text-xs text-muted-foreground">
                          {formatStamp(s.updatedAt, group.key, locale)}
                        </div>
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="min-w-0 flex-1 text-left"
                        onClick={() => chat.handleSelectSession(s.id)}
                        onDoubleClick={() => startRename(s)}
                      >
                        <div className="truncate text-sm text-foreground">
                          {s.title}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {formatStamp(s.updatedAt, group.key, locale)}
                        </div>
                      </button>
                    )}
                    {isEditing ? (
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          // onMouseDown 抢在 input 的 onBlur 之前,避免提交两次
                          onMouseDown={(e) => {
                            e.preventDefault();
                            commitRename(s.id);
                          }}
                          className="p-1 text-muted-foreground hover:text-primary"
                          aria-label={LL.session_rename()}
                        >
                          <Check className="size-3.5" />
                        </button>
                        <button
                          type="button"
                          onMouseDown={(e) => {
                            e.preventDefault();
                            cancelRename();
                          }}
                          className="p-1 text-muted-foreground hover:text-destructive"
                          aria-label={LL.session_close()}
                        >
                          <X className="size-3.5" />
                        </button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-0.5 opacity-0 transition-all group-hover:opacity-100">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            startRename(s);
                          }}
                          className="p-1 text-muted-foreground hover:text-foreground"
                          aria-label={LL.session_rename()}
                        >
                          <Pencil className="size-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setPendingDelete(s);
                          }}
                          className="p-1 text-muted-foreground hover:text-destructive"
                          aria-label={LL.session_delete()}
                        >
                          <Trash2 className="size-3.5" />
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ))
        )}
      </div>

      {pendingDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <button
            type="button"
            className="absolute inset-0 cursor-default bg-black/50"
            onClick={() => setPendingDelete(null)}
            aria-label={LL.session_cancel()}
          />
          <div className="relative w-full max-w-sm rounded-lg border border-border bg-background shadow-lg">
            <div className="border-b border-border px-4 py-3">
              <h2 className="text-sm font-medium">
                {LL.session_delete_confirm_title()}
              </h2>
            </div>
            <div className="space-y-2 px-4 py-3 text-sm">
              <p className="text-muted-foreground">
                {LL.session_delete_confirm_desc()}
              </p>
              <p className="truncate font-medium text-foreground">
                {pendingDelete.title}
              </p>
            </div>
            <div className="flex justify-end gap-2 border-t border-border px-4 py-3">
              <button
                type="button"
                onClick={() => setPendingDelete(null)}
                className="rounded-md px-3 py-1.5 text-sm text-foreground hover:bg-accent"
              >
                {LL.session_cancel()}
              </button>
              <button
                type="button"
                onClick={() => {
                  chat.handleDeleteSession(pendingDelete.id);
                  setPendingDelete(null);
                }}
                className="rounded-md bg-destructive px-3 py-1.5 text-sm text-destructive-foreground hover:opacity-90"
              >
                {LL.session_confirm()}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
