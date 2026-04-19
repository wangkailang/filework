import { ShieldAlert } from "lucide-react";
import { useI18nContext } from "../../i18n/i18n-react";

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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-md rounded-lg border border-border bg-background shadow-lg">
        {/* Header */}
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <ShieldAlert className="size-4 text-amber-500 shrink-0" />
          <h2 className="text-sm font-medium">{LL.skillApproval_title()}</h2>
        </div>

        {/* Body */}
        <div className="px-4 py-3 space-y-3 text-sm">
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
                    className="font-mono text-xs bg-muted rounded px-2 py-1 break-all"
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
                    className="font-mono text-xs bg-muted rounded px-2 py-1 break-all"
                  >
                    {hook}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
          <button
            type="button"
            onClick={() => onRespond(false)}
            className="inline-flex items-center justify-center rounded-md border border-border bg-transparent px-3 py-1.5 text-xs font-medium hover:bg-accent hover:text-foreground transition-colors"
          >
            {LL.skillApproval_reject()}
          </button>
          <button
            type="button"
            onClick={() => onRespond(true)}
            className="inline-flex items-center justify-center rounded-md bg-primary text-primary-foreground px-3 py-1.5 text-xs font-medium hover:bg-primary/90 transition-colors"
          >
            {LL.skillApproval_approve()}
          </button>
        </div>
      </div>
    </div>
  );
};
