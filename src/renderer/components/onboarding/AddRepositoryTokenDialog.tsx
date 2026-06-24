import { Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import { Dialog, DialogContent, DialogTitle } from "../ui/dialog";

interface AddRepositoryTokenDialogProps {
  open: boolean;
  title: string;
  labelId: string;
  tokenId: string;
  tokenPlaceholder: string;
  helper: ReactNode;
  label: string;
  token: string;
  creating: boolean;
  onLabelChange: (value: string) => void;
  onTokenChange: (value: string) => void;
  onSave: () => void;
  onCancel: () => void;
}

export const AddRepositoryTokenDialog = ({
  open,
  title,
  labelId,
  tokenId,
  tokenPlaceholder,
  helper,
  label,
  token,
  creating,
  onLabelChange,
  onTokenChange,
  onSave,
  onCancel,
}: AddRepositoryTokenDialogProps) => (
  <Dialog
    open={open}
    onOpenChange={(nextOpen) => {
      if (!nextOpen) onCancel();
    }}
  >
    <DialogContent className="bg-background! text-foreground! w-full! max-w-md! p-0! overflow-hidden">
      <div className="px-5 py-4 pr-12 border-b border-border">
        <DialogTitle className="text-base font-semibold">{title}</DialogTitle>
      </div>

      <div className="space-y-3 p-5">
        <div>
          <label
            htmlFor={labelId}
            className="block text-xs font-medium text-foreground mb-1"
          >
            Label
          </label>
          <input
            id={labelId}
            type="text"
            value={label}
            onChange={(e) => onLabelChange(e.target.value)}
            placeholder="e.g. work account"
            className="w-full px-2 py-1.5 text-sm rounded-md border border-border bg-background"
          />
        </div>
        <div>
          <label
            htmlFor={tokenId}
            className="block text-xs font-medium text-foreground mb-1"
          >
            Personal Access Token
          </label>
          <input
            id={tokenId}
            type="password"
            value={token}
            onChange={(e) => onTokenChange(e.target.value)}
            placeholder={tokenPlaceholder}
            className="w-full px-2 py-1.5 text-sm rounded-md border border-border bg-background font-mono"
          />
          <div className="text-xs text-muted-foreground mt-1">{helper}</div>
        </div>
      </div>

      <div className="px-5 py-3 border-t border-border flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="px-3 py-1.5 text-sm border border-border rounded-md hover:bg-accent"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onSave}
          disabled={creating || !token.trim() || !label.trim()}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50"
        >
          {creating && <Loader2 className="w-3 h-3 animate-spin" />}
          Save token
        </button>
      </div>
    </DialogContent>
  </Dialog>
);
