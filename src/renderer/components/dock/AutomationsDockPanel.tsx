import { useChatSessionLite } from "../chat/ChatSessionProvider";
import {
  type AutomationRunRecord,
  AutomationsPanel,
} from "../settings/AutomationsPanel";

export const AutomationsDockPanel = ({
  initialView = "tasks",
  onOpenChatDetails,
  viewRevision = 0,
}: {
  initialView?: "tasks" | "triage";
  onOpenChatDetails?: (run: AutomationRunRecord) => void;
  viewRevision?: number;
}) => {
  const chat = useChatSessionLite();
  const activeAutomationRun =
    chat.transientAutomationRun ??
    chat.sessions.find((session) => session.id === chat.activeSessionId)
      ?.automationRun ??
    null;

  const handleOpenRunDetails = async (run: AutomationRunRecord) => {
    const opened = await chat.handleOpenAutomationRun(run);
    if (opened) onOpenChatDetails?.(run);
  };

  return (
    <div className="h-full overflow-y-auto p-4">
      <AutomationsPanel
        activeAutomationId={activeAutomationRun?.automationId ?? null}
        activeAutomationRunId={activeAutomationRun?.id ?? null}
        key={`${initialView}:${viewRevision}`}
        initialView={initialView}
        onOpenRunDetails={handleOpenRunDetails}
        onRerunAutomationRun={(_run, automation) =>
          chat.handleTriggerAutomationRun(automation)
        }
        onTriggerAutomation={(automation) =>
          chat.handleTriggerAutomationRun(automation)
        }
      />
    </div>
  );
};
