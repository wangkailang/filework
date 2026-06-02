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
import { getToolLabels } from "./tool-labels";

// ---------------------------------------------------------------------------
// 类型 —— 从共享的核心类型重新导出,使 JSONL 会话存储与渲染层
// 共用同一份事实来源。
// ---------------------------------------------------------------------------

export type { ToolState } from "../../../main/core/session/message-parts";

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

interface ToolProps extends HTMLAttributes<HTMLDivElement> {
  defaultOpen?: boolean;
  /** 为 true 时强制展开该工具(覆盖内部状态) */
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
          // 收起态:无边框密集单行,几乎不占视觉空间
          // 展开态:才显示边框 + 背景,凸显出当前查看的调用
          "rounded-md text-sm overflow-hidden transition-colors",
          isOpen && "border border-border bg-muted/30",
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
  /** 可选的单行摘要,渲染在工具名称之后(例如 "src/index.ts · 142 lines") */
  summary?: ReactNode;
}

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
  summary,
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
    // 触发器是 <button>(默认 inline-block → max-content),不给 w-full 它会被
    // 内容撑开,里面的 flex-1 summary 就拿不到收缩边界、truncate 永不生效。
    <CollapsibleTrigger asChild className="block w-full min-w-0">
      <div
        className={cn(
          "flex items-center gap-1.5 px-2 py-1 cursor-pointer select-none rounded-md hover:bg-muted/50 transition-colors min-w-0",
          className,
        )}
        {...props}
      >
        {open ? (
          <ChevronDown className="size-3.5 text-muted-foreground shrink-0" />
        ) : (
          <ChevronRight className="size-3.5 text-muted-foreground shrink-0" />
        )}
        <span
          className={cn("flex items-center gap-1.5 shrink-0", config.color)}
        >
          {config.icon}
          <span className="text-xs font-medium">{stateLabel}</span>
        </span>
        <span className="text-xs text-muted-foreground font-mono shrink-0">
          {label}
        </span>
        {summary != null && (
          <span className="text-xs text-muted-foreground/80 font-mono truncate min-w-0 flex-1">
            {summary}
          </span>
        )}
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
// Input(工具参数)
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
// Output(工具结果)
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
