import { ShieldAlert } from "lucide-react";

import type {
  BrowserApprovalDecision,
  BrowserApprovalRequest,
} from "../../../shared/browser";
import { useI18nContext } from "../../i18n/i18n-react";

interface BrowserAccessPromptProps {
  request: BrowserApprovalRequest;
  onRespond: (decision: BrowserApprovalDecision) => void;
}

export function BrowserAccessPrompt({
  request,
  onRespond,
}: BrowserAccessPromptProps) {
  const { LL } = useI18nContext();
  const isOrigin = request.kind === "origin";
  const titleId = `browser-approval-title-${request.requestId}`;
  return (
    <section
      data-browser-access-prompt={request.kind}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className="absolute inset-0 z-30 grid place-items-center bg-background/10 p-4 backdrop-blur-[1px]"
      aria-live="assertive"
    >
      <div
        data-browser-access-card="true"
        className="w-full max-w-sm rounded-2xl border border-border/80 bg-background/95 p-4 shadow-2xl backdrop-blur-xl"
      >
        <div className="flex items-start gap-3">
          <div className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-xl bg-status-await/12 text-status-await ring-1 ring-status-await/15">
            <ShieldAlert className="size-4" />
          </div>
          <div className="min-w-0 flex-1">
            <h3
              id={titleId}
              className="text-sm font-semibold tracking-tight text-foreground"
            >
              {isOrigin
                ? LL.browserApproval_originTitle()
                : LL.browserApproval_sensitiveTitle()}
            </h3>
            <p className="mt-1.5 truncate font-mono text-[11px] text-muted-foreground">
              {request.origin}
            </p>
            {request.action && (
              <p className="mt-1.5 text-xs text-foreground/75">
                {request.action.type} · {request.action.target}
              </p>
            )}
          </div>
        </div>
        <div className="mt-4 flex flex-wrap justify-end gap-1.5">
          {isOrigin ? (
            <>
              <button
                type="button"
                onClick={() => onRespond("block")}
                className="rounded-md px-2.5 py-1.5 text-xs text-destructive transition-colors hover:bg-destructive/10"
              >
                {LL.browserApproval_block()}
              </button>
              <button
                type="button"
                onClick={() => onRespond("allow-once")}
                className="rounded-md border border-border bg-background/60 px-2.5 py-1.5 text-xs transition-colors hover:bg-accent"
              >
                {LL.browserApproval_allowOnce()}
              </button>
              <button
                type="button"
                onClick={() => onRespond("always-allow")}
                className="rounded-md bg-primary px-2.5 py-1.5 text-xs text-primary-foreground shadow-sm transition-colors hover:bg-primary/90"
              >
                {LL.browserApproval_alwaysAllow()}
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => onRespond("deny")}
                className="rounded-md border border-border bg-background/60 px-2.5 py-1.5 text-xs transition-colors hover:bg-accent"
              >
                {LL.browserApproval_deny()}
              </button>
              <button
                type="button"
                onClick={() => onRespond("approve-once")}
                className="rounded-md bg-primary px-2.5 py-1.5 text-xs text-primary-foreground shadow-sm transition-colors hover:bg-primary/90"
              >
                {LL.browserApproval_approveOnce()}
              </button>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
