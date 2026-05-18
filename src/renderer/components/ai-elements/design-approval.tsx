import { CheckCircle2, ClipboardCheck, Pencil, XCircle } from "lucide-react";
import { useState } from "react";

import { cn } from "../../lib/utils";
import { MessageResponse } from "./message";

export interface DesignApprovalCardLabels {
  /** Card header e.g. "Design awaiting approval". */
  pendingHeader: string;
  /** Card header when approved. */
  approvedHeader: string;
  /** Card header when rejected. */
  rejectedHeader: string;
  /** Approve button label. */
  approve: string;
  /** Reject button label. */
  reject: string;
  /** Edit button label (toggles textarea). */
  edit: string;
  /** Save-and-approve label inside the edit form. */
  saveAndApprove: string;
  /** Reject reason textarea placeholder. */
  rejectReasonPlaceholder: string;
  /** "Approved" lozenge. */
  approvedBadge: string;
  /** "Rejected" lozenge. */
  rejectedBadge: string;
  /** Cancel-edit. */
  cancel: string;
}

export interface DesignApprovalCardProps {
  workflowKey: string;
  design: string;
  summary?: string;
  state: "pending" | "approved" | "rejected";
  rejectReason?: string;
  labels: DesignApprovalCardLabels;
  /**
   * Approve clicked. `editedDesign` is provided when the user used
   * "Edit & approve" — call sites may want to inject it into the next
   * agent turn so the agent sees the user's edits.
   */
  onApprove: (params: { editedDesign?: string }) => void;
  onReject: (reason: string) => void;
}

export const DesignApprovalCard = ({
  workflowKey: _workflowKey,
  design,
  summary,
  state,
  rejectReason,
  labels,
  onApprove,
  onReject,
}: DesignApprovalCardProps) => {
  const [mode, setMode] = useState<"view" | "edit" | "reject">("view");
  const [editedDesign, setEditedDesign] = useState(design);
  const [reason, setReason] = useState("");

  const decided = state !== "pending";

  return (
    <div
      data-state={state}
      className={cn(
        "rounded-lg border my-1 overflow-hidden",
        state === "pending" && "border-primary/40 bg-primary/5",
        state === "approved" && "border-green-500/40 bg-green-500/5",
        state === "rejected" && "border-red-500/40 bg-red-500/5",
      )}
    >
      <header className="flex items-center gap-2 px-3 py-2 border-b border-border/50">
        <ClipboardCheck
          className={cn(
            "size-4 shrink-0",
            state === "pending" && "text-primary",
            state === "approved" && "text-green-500",
            state === "rejected" && "text-red-500",
          )}
        />
        <div className="flex-1 min-w-0">
          <div className="text-xs font-medium leading-tight">
            {state === "pending"
              ? labels.pendingHeader
              : state === "approved"
                ? labels.approvedHeader
                : labels.rejectedHeader}
          </div>
          {summary && (
            <div className="text-xs text-muted-foreground truncate mt-0.5">
              {summary}
            </div>
          )}
        </div>
        {state === "approved" && (
          <span className="text-[10px] font-semibold uppercase tracking-wide text-green-600 dark:text-green-400">
            {labels.approvedBadge}
          </span>
        )}
        {state === "rejected" && (
          <span className="text-[10px] font-semibold uppercase tracking-wide text-red-600 dark:text-red-400">
            {labels.rejectedBadge}
          </span>
        )}
      </header>

      <div className="px-3 py-2.5">
        {mode === "edit" ? (
          <textarea
            value={editedDesign}
            onChange={(e) => setEditedDesign(e.target.value)}
            className="w-full min-h-[200px] text-xs font-mono rounded-md border border-border bg-background p-2 resize-y focus:outline-none focus:ring-1 focus:ring-primary"
          />
        ) : (
          <div className="text-xs leading-relaxed prose prose-sm max-w-none dark:prose-invert">
            <MessageResponse>{design}</MessageResponse>
          </div>
        )}

        {state === "rejected" && rejectReason && (
          <div className="mt-2 text-xs text-red-600 dark:text-red-400">
            <span className="font-semibold">↳ </span>
            {rejectReason}
          </div>
        )}

        {mode === "reject" && !decided && (
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={labels.rejectReasonPlaceholder}
            className="w-full mt-2 min-h-[60px] text-xs rounded-md border border-border bg-background p-2 resize-y focus:outline-none focus:ring-1 focus:ring-primary"
          />
        )}
      </div>

      {!decided && (
        <footer className="flex items-center justify-end gap-1.5 px-3 py-2 border-t border-border/50 bg-background/40">
          {mode === "view" && (
            <>
              <button
                type="button"
                onClick={() => setMode("edit")}
                className="inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded-md border border-border hover:bg-accent transition-colors"
              >
                <Pencil className="size-3" />
                {labels.edit}
              </button>
              <button
                type="button"
                onClick={() => setMode("reject")}
                className="inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded-md border border-border text-red-600 hover:bg-red-500/10 dark:text-red-400 transition-colors"
              >
                <XCircle className="size-3" />
                {labels.reject}
              </button>
              <button
                type="button"
                onClick={() => onApprove({})}
                className="inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
              >
                <CheckCircle2 className="size-3" />
                {labels.approve}
              </button>
            </>
          )}

          {mode === "edit" && (
            <>
              <button
                type="button"
                onClick={() => {
                  setEditedDesign(design);
                  setMode("view");
                }}
                className="inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded-md border border-border hover:bg-accent transition-colors"
              >
                {labels.cancel}
              </button>
              <button
                type="button"
                onClick={() =>
                  onApprove({
                    editedDesign:
                      editedDesign.trim() === design.trim()
                        ? undefined
                        : editedDesign,
                  })
                }
                className="inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
              >
                <CheckCircle2 className="size-3" />
                {labels.saveAndApprove}
              </button>
            </>
          )}

          {mode === "reject" && (
            <>
              <button
                type="button"
                onClick={() => {
                  setReason("");
                  setMode("view");
                }}
                className="inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded-md border border-border hover:bg-accent transition-colors"
              >
                {labels.cancel}
              </button>
              <button
                type="button"
                disabled={reason.trim().length === 0}
                onClick={() => onReject(reason.trim())}
                className="inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded-md bg-red-600 text-white hover:bg-red-700 disabled:bg-red-300 disabled:cursor-not-allowed transition-colors"
              >
                <XCircle className="size-3" />
                {labels.reject}
              </button>
            </>
          )}
        </footer>
      )}
    </div>
  );
};
