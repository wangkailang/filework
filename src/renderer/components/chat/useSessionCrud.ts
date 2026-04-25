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
  const activeSessionIdRef = useRef<string | null>(null);
  const messagesRef = useRef<ChatMessage[]>([]);
  activeSessionIdRef.current = activeSessionId;
  messagesRef.current = messages;

  const flushPendingSave = useCallback(() => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }

    const sessionId = activeSessionIdRef.current;
    const latestMessages = messagesRef.current;
    if (latestMessages.length > 0 && sessionId) {
      window.filework.saveChatHistory(sessionId, workspacePath, latestMessages);
    }
  }, [workspacePath]);

  const debouncedSave = useCallback(
    (msgs: ChatMessage[], sessionId: string) => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        window.filework.saveChatHistory(sessionId, workspacePath, msgs);
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
    setSessions((prev) => [session, ...prev]);
    setActiveSessionId(session.id);
    setMessages([]);
    return session.id;
  }, [flushPendingSave, workspacePath]);

  const handleNewChat = useCallback(
    async (isLoading: boolean) => {
      if (isLoading) return;
      setLastUsage(null);
      setLastError(null);
      await createNewSession();
    },
    [createNewSession],
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
    handleForkSession,
  };
}
