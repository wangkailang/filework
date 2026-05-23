/**
 * Lightweight local port of Vercel ai-elements' `InlineCitation`
 * component family. We don't pull in Radix/Floating-UI; the open
 * state lives in a tiny React context and `InlineCitationCardBody`
 * renders inline below the trigger (rather than as a floating
 * popover) — this fits the narrow right-side panel where a floating
 * card would clip against the workspace edge.
 *
 * Sub-components mirror upstream so the API stays portable:
 *   InlineCitation, InlineCitationCard, InlineCitationCardTrigger,
 *   InlineCitationCardBody, InlineCitationSource, InlineCitationQuote.
 */

import {
  createContext,
  type HTMLAttributes,
  type ReactNode,
  useContext,
  useState,
} from "react";
import { cn } from "../../lib/utils";

interface CitationCtx {
  open: boolean;
  setOpen: (next: boolean | ((prev: boolean) => boolean)) => void;
}

const Ctx = createContext<CitationCtx | null>(null);

function useCitation(): CitationCtx {
  const ctx = useContext(Ctx);
  if (!ctx) {
    throw new Error(
      "InlineCitation* must be rendered inside <InlineCitationCard>",
    );
  }
  return ctx;
}

export function InlineCitation({
  children,
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span className={cn("inline", className)} {...props}>
      {children}
    </span>
  );
}

interface InlineCitationCardProps extends HTMLAttributes<HTMLDivElement> {
  defaultOpen?: boolean;
}

export function InlineCitationCard({
  children,
  className,
  defaultOpen = false,
  ...props
}: InlineCitationCardProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Ctx.Provider value={{ open, setOpen }}>
      <div
        className={cn(
          "relative rounded border border-border bg-muted/30 text-xs",
          className,
        )}
        data-state={open ? "open" : "closed"}
        {...props}
      >
        {children}
      </div>
    </Ctx.Provider>
  );
}

interface InlineCitationCardTriggerProps
  extends HTMLAttributes<HTMLButtonElement> {
  /** Source URLs (or paths) — used to render a count badge when no
   *  custom children are passed. */
  sources?: string[];
}

export function InlineCitationCardTrigger({
  sources,
  className,
  children,
  onClick,
  ...props
}: InlineCitationCardTriggerProps) {
  const { open, setOpen } = useCitation();
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={(e) => {
        onClick?.(e);
        if (!e.defaultPrevented) setOpen((v) => !v);
      }}
      className={cn(
        "w-full text-left flex items-center gap-1.5 px-2 py-1.5 hover:bg-accent/40 rounded",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        className,
      )}
      {...props}
    >
      {children ?? (
        <span className="font-mono text-muted-foreground">
          {sources?.length ?? 0}
        </span>
      )}
    </button>
  );
}

export function InlineCitationCardBody({
  children,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  const { open } = useCitation();
  if (!open) return null;
  return (
    <div className={cn("px-2 pb-2 space-y-1.5", className)} {...props}>
      {children}
    </div>
  );
}

interface InlineCitationSourceProps extends HTMLAttributes<HTMLDivElement> {
  title?: string;
  url?: string;
  description?: ReactNode;
}

export function InlineCitationSource({
  title,
  url,
  description,
  className,
  children,
  ...props
}: InlineCitationSourceProps) {
  return (
    <div className={cn("space-y-0.5", className)} {...props}>
      {title && (
        <div className="font-medium text-foreground truncate">{title}</div>
      )}
      {url && (
        <div className="font-mono text-[10px] text-muted-foreground truncate">
          {url}
        </div>
      )}
      {description && (
        <div className="text-muted-foreground">{description}</div>
      )}
      {children}
    </div>
  );
}

export function InlineCitationQuote({
  children,
  className,
  ...props
}: HTMLAttributes<HTMLQuoteElement>) {
  return (
    <blockquote
      className={cn(
        "border-l-2 border-border pl-2 text-muted-foreground",
        className,
      )}
      {...props}
    >
      {children}
    </blockquote>
  );
}
