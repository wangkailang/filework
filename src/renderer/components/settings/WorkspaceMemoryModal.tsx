import { Bot } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "../ui/dialog";
import { WorkspaceMemoryPanel } from "./WorkspaceMemoryPanel";

// 工作目录记忆弹窗:从 chat 头部的 memory 图标打开,查看当前目录的记忆。
// 比放进全局设置更贴合「当前工作目录」这个上下文。
export const WorkspaceMemoryModal = ({
  open,
  onClose,
  workspacePath,
}: {
  open: boolean;
  onClose: () => void;
  workspacePath?: string;
}) => {
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
    >
      <DialogContent className="flex! flex-col gap-0! overflow-hidden bg-background! p-0! text-foreground! shadow-2xl w-[640px]! max-w-[calc(100vw-64px)]! max-h-[80vh]!">
        <div className="flex items-center border-b border-border px-5 py-3 pr-12">
          <DialogTitle className="flex items-center gap-2 text-sm font-medium text-foreground">
            <Bot className="w-4 h-4 text-orange-400" />
            Workspace Memory
          </DialogTitle>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4">
          <WorkspaceMemoryPanel workspacePath={workspacePath} />
        </div>
      </DialogContent>
    </Dialog>
  );
};
