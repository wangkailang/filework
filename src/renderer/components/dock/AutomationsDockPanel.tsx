import { useEffect, useState } from "react";
import { useChatSessionContext } from "../chat/ChatSessionProvider";
import {
  type AutomationRecord,
  AutomationsPanel,
} from "../settings/AutomationsPanel";

const buildAutomationManualPrompt = (automation: AutomationRecord): string => {
  const lines = [
    `Run automation now: ${automation.title}`,
    `Automation type: ${automation.type}`,
    `Schedule: ${automation.scheduleKind} ${automation.scheduleValue}`,
  ];
  if (automation.workspacePaths?.length) {
    lines.push(`Workspace paths: ${automation.workspacePaths.join(", ")}`);
  }
  if (automation.modelId) lines.push(`Model override: ${automation.modelId}`);
  if (automation.reasoningEffort) {
    lines.push(`Reasoning effort: ${automation.reasoningEffort}`);
  }
  lines.push("", "Instructions:", automation.prompt);
  return lines.join("\n");
};

export const AutomationsDockPanel = () => {
  const chat = useChatSessionContext();
  const [runningAutomationId, setRunningAutomationId] = useState<string | null>(
    null,
  );
  const [observedChatRunning, setObservedChatRunning] = useState(false);

  useEffect(() => {
    if (!runningAutomationId) {
      setObservedChatRunning(false);
      return;
    }
    if (chat.isLoading) {
      setObservedChatRunning(true);
      return;
    }
    if (observedChatRunning) {
      setRunningAutomationId(null);
      setObservedChatRunning(false);
    }
  }, [chat.isLoading, observedChatRunning, runningAutomationId]);

  const handleTriggerAutomation = async (automation: AutomationRecord) => {
    if (chat.isLoading) {
      throw new Error("Current chat is still running.");
    }
    setRunningAutomationId(automation.id);
    setObservedChatRunning(false);
    try {
      await chat.handleSubmit({
        text: buildAutomationManualPrompt(automation),
      });
    } catch (err) {
      setRunningAutomationId(null);
      setObservedChatRunning(false);
      throw err;
    }
  };

  return (
    <div className="h-full overflow-y-auto p-4">
      <AutomationsPanel
        onTriggerAutomation={handleTriggerAutomation}
        runningAutomationId={runningAutomationId}
      />
    </div>
  );
};
