import {
  CopyIcon,
  History,
  Loader2,
  MessageSquarePlus,
  Sparkles,
} from "lucide-react";
import { useState } from "react";
import {
  Confirmation,
  ConfirmationAccepted,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationRejected,
  ConfirmationRequest,
} from "../ai-elements/confirmation";
import {
  Conversation,
  ConversationContent,
  ConversationDownload,
  ConversationEmptyState,
  ConversationScrollButton,
} from "../ai-elements/conversation";
import {
  Message,
  MessageAction,
  MessageActions,
  MessageContent,
  MessageResponse,
} from "../ai-elements/message";
import { PlanViewer } from "../ai-elements/plan-viewer";
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
} from "../ai-elements/prompt-input";
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from "../ai-elements/tool";
import { migrateToParts } from "./helpers";
import { ModelSelector } from "./ModelSelector";
import { SessionList } from "./SessionList";
import { SkillApprovalDialog } from "./SkillApprovalDialog";
import { SkillMenu } from "./SkillMenu";
import type { MessagePart, PlanMessagePart, ToolPart } from "./types";
import { useChatSession } from "./useChatSession";

const suggestions = [
  "帮我整理这个目录的文件，按类型分类",
  "分析这个目录的内容，生成一份报告",
  "找出所有重复的文件",
  "统计各类型文件的数量和大小",
];

export const ChatPanel = ({ workspacePath }: { workspacePath: string }) => {
  const [showHistory, setShowHistory] = useState(false);
  const chat = useChatSession(workspacePath);

  // ---------------------------------------------------------------------------
  // Render helpers
  // ---------------------------------------------------------------------------
  const renderToolPart = (inv: ToolPart) => (
    <Tool
      key={inv.toolCallId}
      defaultOpen={inv.state === "output-available"}
      forceOpen={inv.approval?.state === "approval-requested"}
    >
      <ToolHeader toolName={inv.toolName} state={inv.state} />
      <ToolContent>
        <ToolInput input={inv.args} />
        {inv.approval && (
          <div className="px-3 py-2 border-b border-border">
            <Confirmation state={inv.approval.state}>
              {inv.approval.state === "approval-requested" && (
                <>
                  <ConfirmationRequest>
                    {inv.approval.description}
                  </ConfirmationRequest>
                  <ConfirmationActions>
                    <ConfirmationAction
                      variant="outline"
                      onClick={() => chat.handleApproval(inv.toolCallId, false)}
                    >
                      拒绝
                    </ConfirmationAction>
                    <ConfirmationAction
                      variant="default"
                      onClick={() => chat.handleApproval(inv.toolCallId, true)}
                    >
                      批准
                    </ConfirmationAction>
                  </ConfirmationActions>
                </>
              )}
              {inv.approval.state === "approval-accepted" && (
                <ConfirmationAccepted>已批准执行</ConfirmationAccepted>
              )}
              {inv.approval.state === "approval-rejected" && (
                <ConfirmationRejected>已拒绝执行</ConfirmationRejected>
              )}
            </Confirmation>
          </div>
        )}
        {inv.state === "output-available" && (
          <ToolOutput
            output={
              <pre className="font-mono whitespace-pre-wrap break-all">
                {typeof inv.result === "string"
                  ? inv.result
                  : JSON.stringify(inv.result, null, 2)}
              </pre>
            }
          />
        )}
      </ToolContent>
    </Tool>
  );

  const renderAssistantParts = (parts: MessagePart[]) => {
    const textKeyCounts = new Map<string, number>();
    return parts.map((part) => {
      if (part.type === "text" && part.text) {
        const baseKey = `text-${part.text}`;
        const keyCount = (textKeyCounts.get(baseKey) ?? 0) + 1;
        textKeyCounts.set(baseKey, keyCount);
        return (
          <MessageResponse key={`${baseKey}-${keyCount}`}>
            {part.text}
          </MessageResponse>
        );
      }
      if (part.type === "tool") {
        return renderToolPart(part);
      }
      if (part.type === "plan") {
        const planPart = part as PlanMessagePart;
        return (
          <PlanViewer
            key={`plan-${planPart.plan.id}`}
            plan={planPart.plan}
            onApprove={
              planPart.plan.status === "draft"
                ? () => chat.handleApprovePlan(planPart.plan.id)
                : undefined
            }
            onReject={
              planPart.plan.status === "draft"
                ? () => chat.handleRejectPlan(planPart.plan.id)
                : undefined
            }
            onCancel={
              planPart.plan.status === "executing" ||
              planPart.plan.status === "approved"
                ? () => chat.handleCancelPlan(planPart.plan.id)
                : undefined
            }
          />
        );
      }
      return null;
    });
  };

  const hasMessages = chat.messages.length > 0;
  const hasSessions = chat.sessions.length > 0;

  // ---------------------------------------------------------------------------
  // JSX
  // ---------------------------------------------------------------------------
  return (
    <div className="relative flex flex-col h-full">
      {showHistory && (
        <SessionList
          sessions={chat.sessions}
          activeId={chat.activeSessionId}
          onSelect={chat.handleSelectSession}
          onDelete={chat.handleDeleteSession}
          onClose={() => setShowHistory(false)}
        />
      )}

      {(hasMessages || hasSessions) && (
        <div className="flex items-center justify-between px-4 py-2 border-b border-border">
          <button
            type="button"
            onClick={() => setShowHistory(true)}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <History className="size-3.5" />
            <span>
              历史对话{hasSessions ? ` (${chat.sessions.length})` : ""}
            </span>
          </button>
          <button
            type="button"
            onClick={chat.handleNewChat}
            disabled={chat.isLoading}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
          >
            <MessageSquarePlus className="size-3.5" />
            <span>新对话</span>
          </button>
        </div>
      )}

      <Conversation className="group">
        <ConversationContent>
          {!hasMessages ? (
            <ConversationEmptyState
              title="有什么可以帮你的？"
              description="告诉我你想对这个目录做什么"
            >
              <div className="grid grid-cols-2 gap-2 max-w-lg w-full">
                {suggestions.map((suggestion) => (
                  <button
                    key={suggestion}
                    type="button"
                    onClick={() => chat.setInput(suggestion)}
                    className="text-left text-sm px-3 py-2 rounded-lg border border-border hover:bg-accent transition-colors text-muted-foreground hover:text-foreground"
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            </ConversationEmptyState>
          ) : (
            <>
              {chat.messages.map((msg, index) => (
                <div key={msg.id}>
                  <Message from={msg.role}>
                    <MessageContent>
                      {msg.role === "assistant"
                        ? renderAssistantParts(msg.parts ?? migrateToParts(msg))
                        : msg.content}
                    </MessageContent>
                  </Message>
                  {msg.role === "assistant" &&
                    index === chat.messages.length - 1 && (
                      <MessageActions>
                        <MessageAction
                          onClick={() =>
                            navigator.clipboard.writeText(msg.content)
                          }
                          label="Copy"
                        >
                          <CopyIcon className="size-3" />
                        </MessageAction>
                      </MessageActions>
                    )}
                </div>
              ))}
              {chat.isLoading &&
                chat.messages[chat.messages.length - 1]?.content === "" &&
                !chat.messages[chat.messages.length - 1]?.parts?.length && (
                  <div className="flex items-center gap-2 px-4 py-2 text-muted-foreground">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span className="text-sm">
                      {chat.isPlanGenerating
                        ? "正在分析任务，生成执行计划..."
                        : "思考中..."}
                    </span>
                    {chat.activeSkill && (
                      <span className="inline-flex items-center gap-1 ml-2 px-2 py-0.5 text-xs rounded-full bg-primary/10 text-primary">
                        <Sparkles className="w-3 h-3" />
                        {chat.activeSkill.skillName}
                        <span className="text-muted-foreground">
                          ({chat.activeSkill.source})
                        </span>
                      </span>
                    )}
                  </div>
                )}
              {chat.activeSkill &&
                chat.isLoading &&
                (chat.messages[chat.messages.length - 1]?.content !== "" ||
                  (chat.messages[chat.messages.length - 1]?.parts?.length ??
                    0) > 0) && (
                  <div className="flex items-center gap-1.5 px-4 py-1">
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded-full bg-primary/10 text-primary">
                      <Sparkles className="w-3 h-3" />
                      {chat.activeSkill.skillName}
                      <span className="text-muted-foreground">
                        ({chat.activeSkill.source})
                      </span>
                    </span>
                  </div>
                )}
            </>
          )}
        </ConversationContent>
        {hasMessages && <ConversationDownload messages={chat.messages} />}
        <ConversationScrollButton />
      </Conversation>

      <div className="px-6 py-4">
        <div className="max-w-2xl mx-auto">
          <PromptInput onSubmit={chat.handleSubmit}>
            <PromptInputBody>
              <div className="relative">
                <SkillMenu
                  input={chat.input}
                  onSelect={(cmd) => chat.setInput(cmd)}
                />
                <PromptInputTextarea
                  value={chat.input}
                  onChange={(e) => chat.setInput(e.target.value)}
                  placeholder="告诉我你想做什么... (Enter 发送)"
                />
              </div>
            </PromptInputBody>
            <PromptInputFooter>
              <ModelSelector
                selectedConfigId={chat.selectedLlmConfigId}
                onSelect={chat.setSelectedLlmConfigId}
              />
              <PromptInputSubmit
                disabled={false}
                status={chat.isLoading ? "streaming" : "ready"}
                onStop={chat.handleStopGeneration}
              />
            </PromptInputFooter>
          </PromptInput>
        </div>
      </div>

      {chat.pendingSkillApproval && (
        <SkillApprovalDialog
          data={chat.pendingSkillApproval}
          onRespond={chat.handleSkillApproval}
        />
      )}
    </div>
  );
};
