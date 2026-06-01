import { useCallback, useEffect, useRef, useState } from "react";
import { migrateToParts } from "./helpers";
import type { ChatMessage, ChatSession, MessagePart, UsagePart } from "./types";
import type { StreamErrorInfo, UsageInfo } from "./useChatSession";

export function useSessionCrud(workspacePath: string) {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [lastUsage, setLastUsage] = useState<UsageInfo | null>(null);
  const [lastError, setLastError] = useState<StreamErrorInfo | null>(null);

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 标记当前会话是否有"尚未落盘的真实改动"。仅在 debouncedSave(消息编辑/
  // 流式)时置 true,落盘后清零。纯预览会话只 setMessages、不触发它,因此
  // flushPendingSave 对预览是 no-op,不会无谓改写文件 → 不会刷新 updatedAt。
  const dirtyRef = useRef(false);
  const activeSessionIdRef = useRef<string | null>(null);
  const messagesRef = useRef<ChatMessage[]>([]);
  // Set by createNewSession() so the load-history effect below skips the
  // disk fetch on activation — the local caller (e.g. the chat submit
  // handler) has just put messages into state but the JSONL file hasn't
  // been written yet (debouncedSave is on a 500ms timer). Without this
  // guard, getChatHistory returns [] and wipes the in-flight message.
  const freshSessionIdRef = useRef<string | null>(null);
  activeSessionIdRef.current = activeSessionId;
  messagesRef.current = messages;

  const flushPendingSave = useCallback(() => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    // 无真实改动则不落盘 —— 切换/预览会话时不应改写文件刷新 updatedAt。
    if (!dirtyRef.current) return;
    dirtyRef.current = false;

    const sessionId = activeSessionIdRef.current;
    const latestMessages = messagesRef.current;
    if (latestMessages.length > 0 && sessionId) {
      window.filework.saveChatHistory(sessionId, workspacePath, latestMessages);
    }
  }, [workspacePath]);

  const debouncedSave = useCallback(
    (msgs: ChatMessage[], sessionId: string) => {
      dirtyRef.current = true;
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        window.filework.saveChatHistory(sessionId, workspacePath, msgs);
        saveTimerRef.current = null;
        dirtyRef.current = false;
      }, 500);
    },
    [workspacePath],
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
          setMessages([]);
        }
      } catch {
        setSessions([]);
        setActiveSessionId(null);
        setMessages([]);
      }
    };
    load();
  }, [workspacePath]);

  useEffect(() => {
    if (!activeSessionId) {
      setMessages([]);
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
        setMessages(migrated);

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
        setMessages([]);
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
    const session: ChatSession =
      await window.filework.createChatSession(workspacePath);
    // Flag the load-history effect to skip the disk read on activation —
    // the caller (submit handler) is about to set messages itself.
    freshSessionIdRef.current = session.id;
    setSessions((prev) => [session, ...prev]);
    setActiveSessionId(session.id);
    setMessages([]);
    return session.id;
  }, [flushPendingSave, workspacePath]);

  const handleNewChat = useCallback(
    (isLoading: boolean) => {
      if (isLoading) return;
      // Don't persist a new session yet — it's created lazily on the
      // first message submit (useChatSession.ts). Otherwise an empty
      // ".jsonl" file leaks into the sidebar.
      flushPendingSave();
      setActiveSessionId(null);
      setMessages([]);
      setLastUsage(null);
      setLastError(null);
    },
    [flushPendingSave],
  );

  const handleSelectSession = useCallback(
    (sessionId: string, isLoading: boolean) => {
      if (isLoading || sessionId === activeSessionId) return;
      flushPendingSave();
      setActiveSessionId(sessionId);
      setLastUsage(null);
      setLastError(null);
    },
    [activeSessionId, flushPendingSave],
  );

  const handleDeleteSession = useCallback(
    async (sessionId: string) => {
      if (sessionId === activeSessionId) {
        flushPendingSave();
      }
      await window.filework.deleteChatSession(sessionId);
      setSessions((prev) => prev.filter((s) => s.id !== sessionId));
      if (sessionId === activeSessionId) {
        const remaining = sessions.filter((s) => s.id !== sessionId);
        if (remaining.length > 0) {
          setActiveSessionId(remaining[0].id);
        } else {
          setActiveSessionId(null);
          setMessages([]);
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
    messages,
    setMessages,
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
