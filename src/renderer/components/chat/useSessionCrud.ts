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
  activeSessionIdRef.current = activeSessionId;

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
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      if (messages.length > 0 && activeSessionId) {
        window.filework.saveChatHistory(
          activeSessionId,
          workspacePath,
          messages,
        );
      }
    };
  }, [workspacePath, messages, activeSessionId]);

  const createNewSession = useCallback(async (): Promise<string> => {
    const session: ChatSession =
      await window.filework.createChatSession(workspacePath);
    setSessions((prev) => [session, ...prev]);
    setActiveSessionId(session.id);
    setMessages([]);
    return session.id;
  }, [workspacePath]);

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
      setActiveSessionId(sessionId);
      setLastUsage(null);
      setLastError(null);
    },
    [activeSessionId],
  );

  const handleDeleteSession = useCallback(
    async (sessionId: string) => {
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
    [activeSessionId, sessions],
  );

  const handleForkSession = useCallback(
    async (fromMessageId: string, isLoading: boolean) => {
      if (isLoading || !activeSessionId) return;
      try {
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
    [activeSessionId],
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
