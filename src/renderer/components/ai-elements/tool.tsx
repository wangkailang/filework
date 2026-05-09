import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDashed,
  Loader2,
  XCircle,
} from "lucide-react";
import { type HTMLAttributes, type ReactNode, useMemo, useState } from "react";
import type { ToolState } from "../../../main/core/session/message-parts";
import { useI18nContext } from "../../i18n/i18n-react";
import type { TranslationFunctions } from "../../i18n/i18n-types";
import { cn } from "../../lib/utils";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  useCollapsible,
} from "./collapsible";

// ---------------------------------------------------------------------------
// Types — re-exported from the shared core types so the JSONL session store
// and the renderer agree on a single source of truth.
// ---------------------------------------------------------------------------

export type { ToolState } from "../../../main/core/session/message-parts";

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

interface ToolProps extends HTMLAttributes<HTMLDivElement> {
  defaultOpen?: boolean;
  /** When true, forces the tool open (overrides internal state) */
  forceOpen?: boolean;
}

export const Tool = ({
  defaultOpen = false,
  forceOpen,
  children,
  className,
  ...props
}: ToolProps) => {
  const [open, setOpen] = useState(defaultOpen);
  const isOpen = forceOpen || open;
  return (
    <Collapsible open={isOpen} onOpenChange={setOpen}>
      <div
        className={cn(
          "rounded-lg border border-border bg-muted/40 text-sm overflow-hidden",
          className,
        )}
        {...props}
      >
        {children}
      </div>
    </Collapsible>
  );
};

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

interface ToolHeaderProps extends HTMLAttributes<HTMLDivElement> {
  toolName: string;
  state: ToolState;
}

import { getToolLabels } from "./tool-labels";

const stateIcons: Record<ToolState, { icon: ReactNode; color: string }> = {
  "input-streaming": {
    icon: <CircleDashed className="size-3.5 animate-pulse" />,
    color: "text-muted-foreground",
  },
  "input-available": {
    icon: <Loader2 className="size-3.5 animate-spin" />,
    color: "text-blue-500",
  },
  "output-available": {
    icon: <CheckCircle2 className="size-3.5" />,
    color: "text-green-500",
  },
  "output-error": {
    icon: <XCircle className="size-3.5" />,
    color: "text-red-500",
  },
};

const getStateLabels = (
  LL: TranslationFunctions,
): Record<ToolState, string> => ({
  "input-streaming": LL.tool_preparing(),
  "input-available": LL.tool_running(),
  "output-available": LL.tool_done(),
  "output-error": LL.tool_error(),
});

export const ToolHeader = ({
  toolName,
  state,
  className,
  ...props
}: ToolHeaderProps) => {
  const { LL } = useI18nContext();
  const config = stateIcons[state];
  const stateLabels = useMemo(() => getStateLabels(LL), [LL]);
  const stateLabel = stateLabels[state];
  const toolLabelMap = useMemo(() => getToolLabels(LL), [LL]);
  const label = toolLabelMap[toolName] || toolName;
  const { open } = useCollapsible();

  return (
    <CollapsibleTrigger asChild>
      <div
        className={cn(
          "flex items-center gap-2 px-3 py-2 cursor-pointer select-none hover:bg-muted/60 transition-colors",
          className,
        )}
        {...props}
      >
        {open ? (
          <ChevronDown className="size-3.5 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-3.5 text-muted-foreground" />
        )}
        <span className={cn("flex items-center gap-1.5", config.color)}>
          {config.icon}
          <span className="text-xs font-medium">{stateLabel}</span>
        </span>
        <span className="text-xs text-muted-foreground font-mono">{label}</span>
      </div>
    </CollapsibleTrigger>
  );
};

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

export const ToolContent = ({
  children,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) => (
  <CollapsibleContent
    className={cn("border-t border-border", className)}
    {...props}
  >
    {children}
  </CollapsibleContent>
);

// ---------------------------------------------------------------------------
// Input (tool arguments)
// ---------------------------------------------------------------------------

interface ToolInputProps extends HTMLAttributes<HTMLDivElement> {
  input: unknown;
}

export const ToolInput = ({ input, className, ...props }: ToolInputProps) => {
  const { LL } = useI18nContext();
  if (input == null) return null;

  const formatted =
    typeof input === "string" ? input : JSON.stringify(input, null, 2);

  return (
    <div
      className={cn("px-3 py-2 border-b border-border", className)}
      {...props}
    >
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
        {LL.tool_params()}
      </div>
      <pre className="text-xs font-mono text-foreground/80 whitespace-pre-wrap break-all max-h-40 overflow-auto">
        {formatted}
      </pre>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Output (tool result)
// ---------------------------------------------------------------------------

interface ToolOutputProps extends HTMLAttributes<HTMLDivElement> {
  output?: ReactNode;
  errorText?: string;
}

export const ToolOutput = ({
  output,
  errorText,
  className,
  ...props
}: ToolOutputProps) => {
  const { LL } = useI18nContext();
  if (!output && !errorText) return null;

  return (
    <div className={cn("px-3 py-2", className)} {...props}>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
        {errorText ? LL.tool_errorLabel() : LL.tool_result()}
      </div>
      {errorText ? (
        <pre className="text-xs font-mono text-red-400 whitespace-pre-wrap break-all">
          {errorText}
        </pre>
      ) : (
        <div className="text-xs text-foreground/80 max-h-60 overflow-auto">
          {typeof output === "string" ? (
            <pre className="font-mono whitespace-pre-wrap break-all">
              {output}
            </pre>
          ) : (
            output
          )}
        </div>
      )}
    </div>
  );
};
