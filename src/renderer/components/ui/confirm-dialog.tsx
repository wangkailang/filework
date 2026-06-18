import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./alert-dialog";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description?: string;
  confirmLabel: string;
  cancelLabel: string;
  busy?: boolean;
  destructive?: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void | Promise<void>;
}

export const ConfirmDialog = ({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel,
  busy = false,
  destructive = false,
  onOpenChange,
  onConfirm,
}: ConfirmDialogProps) => (
  <AlertDialog
    open={open}
    onOpenChange={(nextOpen) => {
      if (!busy) onOpenChange(nextOpen);
    }}
  >
    <AlertDialogContent className="gap-0! overflow-hidden bg-background! p-0! text-foreground! shadow-2xl w-full! max-w-sm!">
      <AlertDialogHeader className="px-5 pt-5 pr-12 pb-4">
        <AlertDialogTitle className="text-sm font-medium text-foreground">
          {title}
        </AlertDialogTitle>
        {description && (
          <AlertDialogDescription className="mt-2 text-xs leading-relaxed text-muted-foreground">
            {description}
          </AlertDialogDescription>
        )}
      </AlertDialogHeader>
      <AlertDialogFooter className="flex justify-end gap-2 border-t border-border px-5 py-3">
        <AlertDialogCancel variant="outline" size="sm" disabled={busy}>
          {cancelLabel}
        </AlertDialogCancel>
        <AlertDialogAction
          variant={destructive ? "destructive" : "default"}
          size="sm"
          onClick={onConfirm}
          disabled={busy}
        >
          {confirmLabel}
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
);
