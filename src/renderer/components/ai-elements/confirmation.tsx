import { CheckCircle2, ShieldAlert, XCircle } from "lucide-react";
import type { HTMLAttributes } from "react";
import { cn } from "../../lib/utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ApprovalState =
  | "approval-requested"
  | "approval-accepted"
  | "approval-rejected";

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

interface ConfirmationProps extends HTMLAttributes<HTMLDivElement> {
  state: ApprovalState;
}

export const Confirmation = ({
  state,
  children,
  className,
  ...props
}: ConfirmationProps) => (
  <div
    data-state={state}
    className={cn(
      "rounded-lg border text-sm",
      state === "approval-requested" && "border-amber-500/40 bg-amber-500/5",
      state === "approval-accepted" && "border-green-500/40 bg-green-500/5",
      state === "approval-rejected" && "border-red-500/40 bg-red-500/5",
      className,
    )}
    {...props}
  >
    {children}
  </div>
);

// ---------------------------------------------------------------------------
// Request (shown while waiting for user decision)
// ---------------------------------------------------------------------------

export const ConfirmationRequest = ({
  children,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn("flex items-start gap-2 px-3 py-2.5", className)}
    {...props}
  >
    <ShieldAlert className="size-4 text-amber-500 mt-0.5 shrink-0" />
    <div className="text-foreground/90 text-xs leading-relaxed">{children}</div>
  </div>
);

// ---------------------------------------------------------------------------
// Accepted
// ---------------------------------------------------------------------------

export const ConfirmationAccepted = ({
  children,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn("flex items-center gap-2 px-3 py-2", className)}
    {...props}
  >
    <CheckCircle2 className="size-3.5 text-green-500 shrink-0" />
    <span className="text-xs text-green-400">{children}</span>
  </div>
);

// ---------------------------------------------------------------------------
// Rejected
// ---------------------------------------------------------------------------

export const ConfirmationRejected = ({
  children,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn("flex items-center gap-2 px-3 py-2", className)}
    {...props}
  >
    <XCircle className="size-3.5 text-red-500 shrink-0" />
    <span className="text-xs text-red-400">{children}</span>
  </div>
);

// ---------------------------------------------------------------------------
// Actions (approve / reject buttons)
// ---------------------------------------------------------------------------

export const ConfirmationActions = ({
  children,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn("flex items-center gap-2 px-3 pb-2.5", className)}
    {...props}
  >
    {children}
  </div>
);

// ---------------------------------------------------------------------------
// Action button
// ---------------------------------------------------------------------------

interface ConfirmationActionProps extends HTMLAttributes<HTMLButtonElement> {
  variant?: "default" | "outline" | "destructive";
  disabled?: boolean;
}

export const ConfirmationAction = ({
  variant = "default",
  disabled,
  children,
  className,
  ...props
}: ConfirmationActionProps) => (
  <button
    type="button"
    disabled={disabled}
    className={cn(
      "inline-flex items-center justify-center rounded-md px-3 py-1 text-xs font-medium transition-colors",
      "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
      "disabled:pointer-events-none disabled:opacity-50",
      variant === "default" &&
        "bg-primary text-primary-foreground hover:bg-primary/90",
      variant === "outline" &&
        "border border-border bg-transparent hover:bg-accent hover:text-foreground",
      variant === "destructive" &&
        "bg-destructive text-destructive-foreground hover:bg-destructive/90",
      className,
    )}
    {...props}
  >
    {children}
  </button>
);
