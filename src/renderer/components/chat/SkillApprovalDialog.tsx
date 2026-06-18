import { ShieldAlert } from "lucide-react";
import { useI18nContext } from "../../i18n/i18n-react";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";

export interface SkillApprovalData {
  skillId: string;
  sourcePath: string;
  commands: string[];
  hooks: string[];
}

interface SkillApprovalDialogProps {
  data: SkillApprovalData;
  onRespond: (approved: boolean) => void;
}

export const SkillApprovalDialog = ({
  data,
  onRespond,
}: SkillApprovalDialogProps) => {
  const { LL } = useI18nContext();

  return (
    <Dialog open>
      <DialogContent className="sm:max-w-md" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldAlert className="size-4 shrink-0 text-status-await" />
            {LL.skillApproval_title()}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {LL.skillApproval_name()}
            {data.skillId}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3 text-sm">
          <div>
            <span className="text-muted-foreground">
              {LL.skillApproval_name()}
            </span>
            <span className="font-medium">{data.skillId}</span>
          </div>
          <div>
            <span className="text-muted-foreground">
              {LL.skillApproval_source()}
            </span>
            <span className="font-mono text-xs break-all">
              {data.sourcePath}
            </span>
          </div>

          {data.commands.length > 0 && (
            <div>
              <span className="text-muted-foreground">
                {LL.skillApproval_commands()}
              </span>
              <ul className="mt-1 space-y-1">
                {data.commands.map((cmd) => (
                  <li
                    key={cmd}
                    className="rounded bg-muted px-2 py-1 font-mono text-xs break-all"
                  >
                    {cmd}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {data.hooks.length > 0 && (
            <div>
              <span className="text-muted-foreground">
                {LL.skillApproval_hooks()}
              </span>
              <ul className="mt-1 space-y-1">
                {data.hooks.map((hook) => (
                  <li
                    key={hook}
                    className="rounded bg-muted px-2 py-1 font-mono text-xs break-all"
                  >
                    {hook}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            type="button"
            onClick={() => onRespond(false)}
            variant="outline"
            size="sm"
          >
            {LL.skillApproval_reject()}
          </Button>
          <Button type="button" onClick={() => onRespond(true)} size="sm">
            {LL.skillApproval_approve()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
