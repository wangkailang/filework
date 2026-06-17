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
          isOpen && "border border-border/45 bg-muted/10",
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
  /** 紧凑模式:隐藏状态文字与工具名,只留状态图标 + 摘要。用于分组子项 ——
   *  分组头已标注工具名,子行不必逐条复读"完成 写入文件"。 */
  dense?: boolean;
  /** 该行是否有可展开内容。false 时不渲染 chevron / 触发器,行变为静态行
   *  (用 chevron 等宽占位保持左边缘对齐)。用于没有内嵌 diff 的写入行等。 */
  collapsible?: boolean;
  /** 行尾常驻动作(hover 显现),挂在触发器之外,避免按钮嵌套按钮。
   *  例如写入行的"打开文件"—— 不必展开折叠即可直达右侧预览。 */
  action?: ReactNode;
}

const stateIcons: Record<ToolState, { icon: ReactNode; color: string }> = {
  "input-streaming": {
    icon: <CircleDashed className="size-3.5 animate-pulse" />,
    color: "text-muted-foreground/75",
  },
  "input-available": {
    icon: <Loader2 className="size-3.5 animate-spin" />,
    color: "text-status-running/75",
  },
  "output-available": {
    icon: <CheckCircle2 className="size-3.5" />,
    color: "text-status-success/70",
  },
  "output-error": {
    icon: <XCircle className="size-3.5" />,
    color: "text-status-error/70",
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
  dense,
  collapsible = true,
  action,
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

  const inner = (
    <>
      {collapsible ? (
        open ? (
          <ChevronDown className="size-3.5 text-muted-foreground/65 shrink-0" />
        ) : (
          <ChevronRight className="size-3.5 text-muted-foreground/65 shrink-0" />
        )
      ) : (
        // 静态行:占位等宽,保持与可展开行的左边缘对齐。
        <span className="size-3.5 shrink-0" aria-hidden="true" />
      )}
      {/* dense 分组里"完成"是默认态,逐行重复绿勾只是噪声 —— 成功时省略
          图标,只在进行中 / 准备中才标记,把状态色留给真正需要关注的行。 */}
      {dense ? (
        state !== "output-available" && (
          <span className={cn("flex items-center shrink-0", config.color)}>
            {config.icon}
          </span>
        )
      ) : (
        <span
          className={cn("flex items-center gap-1.5 shrink-0", config.color)}
        >
          {config.icon}
          <span className="text-xs font-normal">{stateLabel}</span>
        </span>
      )}
      {!dense && (
        <span className="text-xs text-muted-foreground/75 font-mono shrink-0">
          {label}
        </span>
      )}
      {summary != null && (
        <span className="text-xs text-muted-foreground/70 font-mono truncate min-w-0 flex-1">
          {summary}
        </span>
      )}
    </>
  );

  // 外层行承载 hover 背景与行尾动作;触发器只覆盖 chevron+摘要区,动作按钮
  // 作为同级兄弟挂在触发器之外 —— 否则会形成 <button> 套 <button>。
  return (
    <div className="group flex items-center min-w-0 rounded-md hover:bg-muted/25 transition-colors">
      {collapsible ? (
        // 触发器须 flex-1 + min-w-0,内部 summary 才拿得到收缩边界、truncate 生效。
        <CollapsibleTrigger
          asChild
          className="flex flex-1 min-w-0 cursor-pointer select-none"
        >
          <div
            className={cn(
              "flex items-center gap-1.5 px-2 py-1 min-w-0",
              className,
            )}
            {...props}
          >
            {inner}
          </div>
        </CollapsibleTrigger>
      ) : (
        <div
          className={cn(
            "flex flex-1 items-center gap-1.5 px-2 py-1 min-w-0",
            className,
          )}
          {...props}
        >
          {inner}
        </div>
      )}
      {action && (
        <div className="shrink-0 pr-1.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          {action}
        </div>
      )}
    </div>
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
    className={cn("border-t border-border/35", className)}
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
      className={cn("px-3 py-2 border-b border-border/35", className)}
      {...props}
    >
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground/65 mb-1">
        {LL.tool_params()}
      </div>
      <pre className="text-xs font-mono text-muted-foreground/90 whitespace-pre-wrap break-all max-h-40 overflow-auto">
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
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground/65 mb-1">
        {errorText ? LL.tool_errorLabel() : LL.tool_result()}
      </div>
      {errorText ? (
        <pre className="text-xs font-mono text-status-error/80 whitespace-pre-wrap break-all">
          {errorText}
        </pre>
      ) : (
        <div className="text-xs text-muted-foreground/95 max-h-60 overflow-auto">
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
