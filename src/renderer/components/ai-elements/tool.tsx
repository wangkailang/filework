import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDashed,
  Loader2,
  XCircle,
} from "lucide-react";
import { type HTMLAttributes, type ReactNode, useState } from "react";
import { cn } from "../../lib/utils";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  useCollapsible,
} from "./collapsible";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ToolState =
  | "input-streaming"
  | "input-available"
  | "output-available"
  | "output-error";

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

const stateConfig: Record<
  ToolState,
  { icon: ReactNode; label: string; color: string }
> = {
  "input-streaming": {
    icon: <CircleDashed className="size-3.5 animate-pulse" />,
    label: "准备中",
    color: "text-muted-foreground",
  },
  "input-available": {
    icon: <Loader2 className="size-3.5 animate-spin" />,
    label: "执行中",
    color: "text-blue-500",
  },
  "output-available": {
    icon: <CheckCircle2 className="size-3.5" />,
    label: "完成",
    color: "text-green-500",
  },
  "output-error": {
    icon: <XCircle className="size-3.5" />,
    label: "出错",
    color: "text-red-500",
  },
};

/** Human-readable tool name labels */
const toolLabels: Record<string, string> = {
  listDirectory: "列出目录",
  readFile: "读取文件",
  writeFile: "写入文件",
  moveFile: "移动文件",
  createDirectory: "创建目录",
  deleteFile: "删除文件",
  directoryStats: "目录统计",
  findDuplicates: "查找重复文件",
  runCommand: "执行命令",
};

export const ToolHeader = ({
  toolName,
  state,
  className,
  ...props
}: ToolHeaderProps) => {
  const config = stateConfig[state];
  const label = toolLabels[toolName] || toolName;
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
          <span className="text-xs font-medium">{config.label}</span>
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
  if (input == null) return null;

  const formatted =
    typeof input === "string" ? input : JSON.stringify(input, null, 2);

  return (
    <div
      className={cn("px-3 py-2 border-b border-border", className)}
      {...props}
    >
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
        参数
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
  if (!output && !errorText) return null;

  return (
    <div className={cn("px-3 py-2", className)} {...props}>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
        {errorText ? "错误" : "结果"}
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
