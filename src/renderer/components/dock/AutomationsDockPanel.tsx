import { useChatSessionLite } from "../chat/ChatSessionProvider";
import { AutomationsPanel } from "../settings/AutomationsPanel";

export const AutomationsDockPanel = ({
  initialView = "tasks",
  viewRevision = 0,
}: {
  initialView?: "tasks" | "triage";
  viewRevision?: number;
}) => {
  const chat = useChatSessionLite();

  return (
    <div className="h-full overflow-y-auto p-4">
      <AutomationsPanel
        key={`${initialView}:${viewRevision}`}
        initialView={initialView}
        onOpenRunDetails={(run) => chat.handleOpenAutomationRun(run)}
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
