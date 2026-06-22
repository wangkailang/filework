// 把 useChatSession 的返回值放进 context,供对话区、左栏会话列表、顶栏共享。
// Provider 必须 key={workspacePath} 挂载,workspace 切换时整体重置。
//
// 拆成两个 context:
//   - 全量(含高频 messages):仅对话区 ConversationArea/ChatPanel 用。
//   - 低频切片 lite(不含 messages):顶栏 TopBar、左栏 ChatHistoryPanel 用。
//     用 useMemo 让切片在流式逐 token 更新时保持引用稳定 → Context 自动
//     bail-out,这两个区在流式期间不重渲染(等同 zustand selector 的效果)。
import { createContext, useContext, useMemo } from "react";
import { useChatSession } from "./useChatSession";

type ChatSessionValue = ReturnType<typeof useChatSession>;

type ChatSessionLiteValue = Pick<
  ChatSessionValue,
  | "sessions"
  | "activeSessionId"
  | "sessionRunStates"
  | "activeSessionRunState"
  | "selectedLlmConfigId"
  | "isLoading"
  | "setSelectedLlmConfigId"
  | "handleNewChat"
  | "handleTriggerAutomationRun"
  | "handleOpenAutomationRun"
  | "handleSelectSession"
  | "handleDeleteSession"
  | "handleRenameSession"
>;

const ChatSessionContext = createContext<ChatSessionValue | null>(null);
const ChatSessionLiteContext = createContext<ChatSessionLiteValue | null>(null);

export const ChatSessionProvider = ({
  workspacePath,
  workspaceRefJson,
  children,
}: {
  workspacePath: string;
  workspaceRefJson?: string;
  children: React.ReactNode;
}) => {
  const value = useChatSession(workspacePath, workspaceRefJson);
  const lite = useMemo<ChatSessionLiteValue>(
    () => ({
      sessions: value.sessions,
      activeSessionId: value.activeSessionId,
      sessionRunStates: value.sessionRunStates,
      activeSessionRunState: value.activeSessionRunState,
      selectedLlmConfigId: value.selectedLlmConfigId,
      isLoading: value.isLoading,
      setSelectedLlmConfigId: value.setSelectedLlmConfigId,
      handleNewChat: value.handleNewChat,
      handleTriggerAutomationRun: value.handleTriggerAutomationRun,
      handleOpenAutomationRun: value.handleOpenAutomationRun,
      handleSelectSession: value.handleSelectSession,
      handleDeleteSession: value.handleDeleteSession,
      handleRenameSession: value.handleRenameSession,
    }),
    [
      value.sessions,
      value.activeSessionId,
      value.sessionRunStates,
      value.activeSessionRunState,
      value.selectedLlmConfigId,
      value.isLoading,
      value.setSelectedLlmConfigId,
      value.handleNewChat,
      value.handleTriggerAutomationRun,
      value.handleOpenAutomationRun,
      value.handleSelectSession,
      value.handleDeleteSession,
      value.handleRenameSession,
    ],
  );
  return (
    <ChatSessionContext.Provider value={value}>
      <ChatSessionLiteContext.Provider value={lite}>
        {children}
      </ChatSessionLiteContext.Provider>
    </ChatSessionContext.Provider>
  );
};

/** 全量(含高频 messages):仅对话区用。 */
export const useChatSessionContext = (): ChatSessionValue => {
  const ctx = useContext(ChatSessionContext);
  if (!ctx) {
    throw new Error(
      "useChatSessionContext 必须在 <ChatSessionProvider> 内使用",
    );
  }
  return ctx;
};

/** 低频切片:顶栏 / 左栏会话列表用,流式期间不随 messages 重渲。 */
export const useChatSessionLite = (): ChatSessionLiteValue => {
  const ctx = useContext(ChatSessionLiteContext);
  if (!ctx) {
    throw new Error("useChatSessionLite 必须在 <ChatSessionProvider> 内使用");
  }
  return ctx;
};
