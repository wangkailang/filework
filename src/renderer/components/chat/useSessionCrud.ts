import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { migrateToParts } from "./helpers";
import type { ChatMessage, ChatSession, MessagePart, UsagePart } from "./types";
import type { StreamErrorInfo, UsageInfo } from "./useChatSession";

type SessionSaveOptions = {
  lastActiveBranch?: string | null;
};

const normalizeLastActiveBranch = (
  branch: string | null | undefined,
): string | null | undefined => {
  if (branch === undefined) return undefined;
  if (branch === null) return null;
  const trimmed = branch.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const normalizeSessionSaveOptions = (
  options?: SessionSaveOptions,
): SessionSaveOptions | undefined => {
  const lastActiveBranch = normalizeLastActiveBranch(options?.lastActiveBranch);
  return lastActiveBranch !== undefined ? { lastActiveBranch } : undefined;
};

const latestUserTimestamp = (messages: ChatMessage[]): string | null => {
  let latest: string | null = null;
  for (const message of messages) {
    if (message.role !== "user") continue;
    if (latest === null || message.timestamp > latest)
      latest = message.timestamp;
  }
  return latest;
};

const saveChatHistory = (
  sessionId: string,
  workspacePath: string,
  messages: ChatMessage[],
  options?: SessionSaveOptions,
) => {
  if (options) {
    window.filework.saveChatHistory(
      sessionId,
      workspacePath,
      messages,
      options,
    );
  } else {
    window.filework.saveChatHistory(sessionId, workspacePath, messages);
  }
};

export function useSessionCrud(
  workspacePath: string,
  activeBranch?: string | null,
) {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [messages, setMessagesState] = useState<ChatMessage[]>([]);
  const [lastUsage, setLastUsage] = useState<UsageInfo | null>(null);
  const [lastError, setLastError] = useState<StreamErrorInfo | null>(null);

  const saveTimersRef = useRef(
    new Map<string, ReturnType<typeof setTimeout>>(),
  );
  const saveOptionsBySessionRef = useRef(new Map<string, SessionSaveOptions>());
  // 标记当前会话是否有"尚未落盘的真实改动"。仅在 debouncedSave(消息编辑/
  // 流式)时置 true,落盘后清零。纯预览会话只 setMessages、不触发它,因此
  // flushPendingSave 对预览是 no-op,不会无谓改写文件 → 不会刷新 updatedAt。
  const dirtySessionsRef = useRef(new Set<string>());
  const activeSessionIdRef = useRef<string | null>(null);
  const messagesRef = useRef<ChatMessage[]>([]);
  const messagesBySessionRef = useRef(new Map<string, ChatMessage[]>());
  const transientMessagesPendingRef = useRef(false);
  // Set by createNewSession() so the load-history effect below skips the
  // disk fetch on activation — the local caller (e.g. the chat submit
  // handler) has just put messages into state but the JSONL file hasn't
  // been written yet (debouncedSave is on a 500ms timer). Without this
  // guard, getChatHistory returns [] and wipes the in-flight message.
  const freshSessionIdRef = useRef<string | null>(null);
  // 历史加载完成后的回调(由 useChatSession 接上 reattachRunningTask)。让重连严格
  // 排在 setMessages(history) 之后触发,避免重连补的在途消息壳被历史加载覆盖。
  const onHistoryLoadedRef = useRef<((sessionId: string) => void) | null>(null);
  activeSessionIdRef.current = activeSessionId;
  messagesRef.current = messages;

  const branchSnapshot = normalizeLastActiveBranch(activeBranch) ?? null;

  const recordSessionActivity = useCallback(
    (
      sessionId: string,
      nextMessages: ChatMessage[],
      options?: SessionSaveOptions,
    ) => {
      const updatedAt = latestUserTimestamp(nextMessages);
      const normalizedOptions = normalizeSessionSaveOptions(options);
      if (!updatedAt && !normalizedOptions) return;
      setSessions((prev) =>
        prev.map((session) =>
          session.id === sessionId
            ? {
                ...session,
                ...(updatedAt ? { updatedAt } : {}),
                ...(normalizedOptions ?? {}),
              }
            : session,
        ),
      );
    },
    [],
  );

  const setMessages = useCallback<Dispatch<SetStateAction<ChatMessage[]>>>(
    (nextOrUpdater) => {
      setMessagesState((prev) => {
        const next =
          typeof nextOrUpdater === "function"
            ? (nextOrUpdater as (prev: ChatMessage[]) => ChatMessage[])(prev)
            : nextOrUpdater;
        const sessionId = activeSessionIdRef.current;
        if (sessionId) messagesBySessionRef.current.set(sessionId, next);
        messagesRef.current = next;
        return next;
      });
    },
    [],
  );

  const updateSessionMessages = useCallback(
    (
      sessionId: string,
      updater: (prev: ChatMessage[]) => ChatMessage[],
    ): ChatMessage[] => {
      const prev =
        messagesBySessionRef.current.get(sessionId) ??
        (activeSessionIdRef.current === sessionId ? messagesRef.current : []);
      const next = updater(prev);
      messagesBySessionRef.current.set(sessionId, next);
      if (activeSessionIdRef.current === sessionId) {
        messagesRef.current = next;
        setMessagesState(next);
      }
      return next;
    },
    [],
  );

  const flushPendingSave = useCallback(
    (sessionId?: string) => {
      const ids = sessionId
        ? [sessionId]
        : Array.from(dirtySessionsRef.current.values());

      for (const id of ids) {
        const timer = saveTimersRef.current.get(id);
        if (timer) {
          clearTimeout(timer);
          saveTimersRef.current.delete(id);
        }
        // 无真实改动则不落盘 —— 切换/预览会话时不应改写文件刷新 updatedAt。
        if (!dirtySessionsRef.current.has(id)) continue;
        dirtySessionsRef.current.delete(id);

        const latestMessages =
          messagesBySessionRef.current.get(id) ??
          (activeSessionIdRef.current === id ? messagesRef.current : []);
        if (latestMessages.length > 0) {
          const options = saveOptionsBySessionRef.current.get(id);
          saveChatHistory(id, workspacePath, latestMessages, options);
        }
        saveOptionsBySessionRef.current.delete(id);
      }
    },
    [workspacePath],
  );

  const debouncedSave = useCallback(
    (msgs: ChatMessage[], sessionId: string, options?: SessionSaveOptions) => {
      messagesBySessionRef.current.set(sessionId, msgs);
      dirtySessionsRef.current.add(sessionId);
      const normalizedOptions = normalizeSessionSaveOptions(options);
      if (normalizedOptions) {
        saveOptionsBySessionRef.current.set(sessionId, normalizedOptions);
      }
      const effectiveOptions =
        normalizedOptions ?? saveOptionsBySessionRef.current.get(sessionId);
      recordSessionActivity(sessionId, msgs, effectiveOptions);
      const existing = saveTimersRef.current.get(sessionId);
      if (existing) clearTimeout(existing);
      const timer = setTimeout(() => {
        const latestMessages =
          messagesBySessionRef.current.get(sessionId) ?? msgs;
        if (latestMessages.length > 0) {
          const options = saveOptionsBySessionRef.current.get(sessionId);
          saveChatHistory(sessionId, workspacePath, latestMessages, options);
        }
        saveTimersRef.current.delete(sessionId);
        dirtySessionsRef.current.delete(sessionId);
        saveOptionsBySessionRef.current.delete(sessionId);
      }, 500);
      saveTimersRef.current.set(sessionId, timer);
    },
    [recordSessionActivity, workspacePath],
  );

  useEffect(() => {
    const load = async () => {
      try {
        const list: ChatSession[] =
          await window.filework.getChatSessions(workspacePath);
        setSessions(list);
        if (list.length > 0) {
          setActiveSessionId(list[0].id);
        } else {
          setActiveSessionId(null);
          messagesRef.current = [];
          setMessagesState([]);
        }
      } catch {
        setSessions([]);
        setActiveSessionId(null);
        messagesRef.current = [];
        setMessagesState([]);
      }
    };
    load();
  }, [workspacePath]);

  useEffect(() => {
    if (!activeSessionId) {
      if (transientMessagesPendingRef.current) {
        transientMessagesPendingRef.current = false;
        return;
      }
      messagesRef.current = [];
      setMessagesState([]);
      return;
    }
    if (freshSessionIdRef.current === activeSessionId) {
      // Session was just created locally by createNewSession(); the
      // caller will populate messages itself. Skip the disk read so we
      // don't race-wipe the in-flight first message.
      freshSessionIdRef.current = null;
      return;
    }
    const load = async () => {
      try {
        const history = await window.filework.getChatHistory(activeSessionId);
        const migrated = (history ?? []).map((m: ChatMessage) =>
          m.role === "assistant" ? { ...m, parts: migrateToParts(m) } : m,
        );
        messagesBySessionRef.current.set(activeSessionId, migrated);
        messagesRef.current = migrated;
        setMessagesState(migrated);

        for (let i = migrated.length - 1; i >= 0; i--) {
          const msg = migrated[i];
          if (msg.role !== "assistant" || !msg.parts) continue;
          const usagePart = msg.parts.find(
            (p: MessagePart) => p.type === "usage",
          ) as UsagePart | undefined;
          if (usagePart) {
            setLastUsage({
              inputTokens: usagePart.inputTokens,
              outputTokens: usagePart.outputTokens,
              totalTokens: usagePart.totalTokens,
              modelId: usagePart.modelId,
              provider: usagePart.provider,
            });
            break;
          }
        }
      } catch {
        messagesBySessionRef.current.set(activeSessionId, []);
        messagesRef.current = [];
        setMessagesState([]);
      } finally {
        // 历史已就位(成功或失败)→ 此刻才尝试重连,壳会叠加在已加载历史之上。
        onHistoryLoadedRef.current?.(activeSessionId);
      }
    };
    load();
  }, [activeSessionId]);

  useEffect(() => {
    return () => {
      flushPendingSave();
    };
  }, [flushPendingSave]);

  const createNewSession = useCallback(async (): Promise<string> => {
    flushPendingSave();
    transientMessagesPendingRef.current = false;
    const session: ChatSession = await window.filework.createChatSession(
      workspacePath,
      undefined,
      {
        lastActiveBranch: branchSnapshot,
      },
    );
    const sessionWithBranch: ChatSession = {
      ...session,
      lastActiveBranch: session.lastActiveBranch ?? branchSnapshot,
    };
    // Flag the load-history effect to skip the disk read on activation —
    // the caller (submit handler) is about to set messages itself.
    freshSessionIdRef.current = sessionWithBranch.id;
    messagesBySessionRef.current.set(sessionWithBranch.id, []);
    setSessions((prev) => [sessionWithBranch, ...prev]);
    setActiveSessionId(sessionWithBranch.id);
    messagesRef.current = [];
    setMessagesState([]);
    return sessionWithBranch.id;
  }, [branchSnapshot, flushPendingSave, workspacePath]);

  const handleNewChat = useCallback(
    (_isLoading?: boolean) => {
      // Don't persist a new session yet — it's created lazily on the
      // first message submit (useChatSession.ts). Otherwise an empty
      // ".jsonl" file leaks into the sidebar.
      flushPendingSave();
      transientMessagesPendingRef.current = false;
      setActiveSessionId(null);
      messagesRef.current = [];
      setMessagesState([]);
      setLastUsage(null);
      setLastError(null);
    },
    [flushPendingSave],
  );

  const handleSelectSession = useCallback(
    (sessionId: string, _isLoading?: boolean) => {
      if (sessionId === activeSessionId) return;
      flushPendingSave();
      transientMessagesPendingRef.current = false;
      setActiveSessionId(sessionId);
      setLastUsage(null);
      setLastError(null);
    },
    [activeSessionId, flushPendingSave],
  );

  const handleDeleteSession = useCallback(
    async (sessionId: string) => {
      if (sessionId === activeSessionId) {
        flushPendingSave(sessionId);
      }
      const timer = saveTimersRef.current.get(sessionId);
      if (timer) clearTimeout(timer);
      saveTimersRef.current.delete(sessionId);
      dirtySessionsRef.current.delete(sessionId);
      saveOptionsBySessionRef.current.delete(sessionId);
      messagesBySessionRef.current.delete(sessionId);
      await window.filework.deleteChatSession(sessionId);
      setSessions((prev) => prev.filter((s) => s.id !== sessionId));
      if (sessionId === activeSessionId) {
        const remaining = sessions.filter((s) => s.id !== sessionId);
        if (remaining.length > 0) {
          setActiveSessionId(remaining[0].id);
        } else {
          transientMessagesPendingRef.current = false;
          setActiveSessionId(null);
          messagesRef.current = [];
          setMessagesState([]);
        }
      }
    },
    [activeSessionId, flushPendingSave, sessions],
  );

  const handleRenameSession = useCallback(
    async (sessionId: string, rawTitle: string) => {
      const title = rawTitle.trim();
      if (!title) return;
      const current = sessions.find((s) => s.id === sessionId);
      if (!current || current.title === title) return;
      // 仅改标题,保留原 updatedAt —— 重命名不应让会话跳到列表顶部。
      setSessions((prev) =>
        prev.map((s) => (s.id === sessionId ? { ...s, title } : s)),
      );
      await window.filework.updateChatSession(sessionId, {
        title,
        updatedAt: current.updatedAt,
      });
    },
    [sessions],
  );

  const showTransientMessages = useCallback(
    (nextMessages: ChatMessage[]) => {
      flushPendingSave();
      transientMessagesPendingRef.current = true;
      setActiveSessionId(null);
      messagesRef.current = nextMessages;
      setMessagesState(nextMessages);
      setLastUsage(null);
      setLastError(null);
    },
    [flushPendingSave],
  );

  const handleForkSession = useCallback(
    async (fromMessageId: string, isLoading: boolean) => {
      if (isLoading || !activeSessionId) return;
      try {
        flushPendingSave();
        const forked: ChatSession = await window.filework.forkChatSession(
          activeSessionId,
          fromMessageId,
        );
        setSessions((prev) => [forked, ...prev]);
        setActiveSessionId(forked.id);
        setLastUsage(null);
        setLastError(null);
      } catch (err) {
        console.error("[Fork Session] Failed:", err);
      }
    },
    [activeSessionId, flushPendingSave],
  );

  return {
    sessions,
    setSessions,
    activeSessionId,
    activeSessionIdRef,
    onHistoryLoadedRef,
    messages,
    setMessages,
    updateSessionMessages,
    showTransientMessages,
    lastUsage,
    setLastUsage,
    lastError,
    setLastError,
    debouncedSave,
    createNewSession,
    handleNewChat,
    handleSelectSession,
    handleDeleteSession,
    handleRenameSession,
    handleForkSession,
  };
}
