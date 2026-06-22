import { useChatSessionLite } from "../chat/ChatSessionProvider";
import { AutomationsPanel } from "../settings/AutomationsPanel";

export const AutomationsDockPanel = () => {
  const chat = useChatSessionLite();

  return (
    <div className="h-full overflow-y-auto p-4">
      <AutomationsPanel
        onOpenRunDetails={(run) => chat.handleOpenAutomationRun(run)}
        onRerunAutomationRun={(run) =>
          chat.handleTriggerAutomationRun({
            id: run.automationId,
            modelId: run.modelId,
            prompt: run.prompt,
            scheduleKind: "",
            scheduleValue: "",
            title: run.automationTitle,
            type: "standalone",
            workspacePaths: run.workspacePaths,
          })
        }
        onTriggerAutomation={(automation) =>
          chat.handleTriggerAutomationRun(automation)
        }
      />
    </div>
  );
};
