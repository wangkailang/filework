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
  return (
    <section
      data-browser-access-prompt={request.kind}
      className="absolute inset-x-3 bottom-3 z-30 rounded-xl border border-border bg-background/95 p-3 shadow-xl backdrop-blur"
      aria-live="assertive"
    >
      <div className="flex items-start gap-2.5">
        <div className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg bg-status-await/12 text-status-await">
          <ShieldAlert className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-xs font-semibold text-foreground">
            {isOrigin
              ? LL.browserApproval_originTitle()
              : LL.browserApproval_sensitiveTitle()}
          </h3>
          <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
            {request.origin}
          </p>
          {request.action && (
            <p className="mt-1 text-xs text-foreground/75">
              {request.action.type} · {request.action.target}
            </p>
          )}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap justify-end gap-1.5">
        {isOrigin ? (
          <>
            <button
              type="button"
              onClick={() => onRespond("block")}
              className="rounded-md px-2.5 py-1.5 text-xs text-destructive hover:bg-destructive/10"
            >
              {LL.browserApproval_block()}
            </button>
            <button
              type="button"
              onClick={() => onRespond("allow-once")}
              className="rounded-md border border-border px-2.5 py-1.5 text-xs hover:bg-accent"
            >
              {LL.browserApproval_allowOnce()}
            </button>
            <button
              type="button"
              onClick={() => onRespond("always-allow")}
              className="rounded-md bg-primary px-2.5 py-1.5 text-xs text-primary-foreground hover:bg-primary/90"
            >
              {LL.browserApproval_alwaysAllow()}
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={() => onRespond("deny")}
              className="rounded-md border border-border px-2.5 py-1.5 text-xs hover:bg-accent"
            >
              {LL.browserApproval_deny()}
            </button>
            <button
              type="button"
              onClick={() => onRespond("approve-once")}
              className="rounded-md bg-primary px-2.5 py-1.5 text-xs text-primary-foreground hover:bg-primary/90"
            >
              {LL.browserApproval_approveOnce()}
            </button>
          </>
        )}
      </div>
    </section>
  );
}
