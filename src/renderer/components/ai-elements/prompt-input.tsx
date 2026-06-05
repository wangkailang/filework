import { CornerDownLeftIcon, PaperclipIcon, SquareIcon } from "lucide-react";
import type {
  FormEvent,
  HTMLAttributes,
  KeyboardEventHandler,
  TextareaHTMLAttributes,
} from "react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import type { AttachmentPart } from "../../../main/core/session/message-parts";
import { cn } from "../../lib/utils";

// ============================================================================
// 编辑器附件形状 —— 表单的 `attachments` prop。派生自 AttachmentPart,
// 这样在一处重命名字段即可保持单点修改。其他 `ai-elements/*` 已经从
// message-parts 导入(ToolApproval、ApprovalState、PlanView),因此该边界没问题。
// ============================================================================

export type ComposerAttachment = Omit<AttachmentPart, "type">;

// ============================================================================
// Context —— 携带 textarea 的值,使 PromptInput 在提交时能读取它
// ============================================================================

interface PromptInputContextValue {
  value: string;
  setValue: (v: string) => void;
}

const PromptInputContext = createContext<PromptInputContextValue | null>(null);

// ============================================================================
// PromptInput (root form wrapper)
// ============================================================================

export interface PromptInputMessage {
  text: string;
  attachments?: ComposerAttachment[];
}

export type PromptInputProps = Omit<
  HTMLAttributes<HTMLFormElement>,
  "onSubmit"
> & {
  onSubmit: (message: PromptInputMessage) => void | Promise<void>;
  /**
   * 受控的附件列表 —— 由父组件持有,这样兄弟 DOM 上的拖拽和文件选择器都
   * 写入同一份事实来源。提供该 prop 时,PromptInput 会在提交成功后通过
   * `onAttachmentsChange([])` 清空它。
   */
  attachments?: ComposerAttachment[];
  onAttachmentsChange?: (next: ComposerAttachment[]) => void;
};

export const PromptInput = ({
  className,
  onSubmit,
  children,
  attachments,
  onAttachmentsChange,
  ...props
}: PromptInputProps) => {
  const [value, setValue] = useState("");
  const atts = attachments ?? [];

  const handleSubmit = useCallback(
    async (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      if (!value.trim() && atts.length === 0) return;
      const result = onSubmit({
        text: value,
        attachments: atts.length > 0 ? atts : undefined,
      });
      if (result instanceof Promise) {
        await result;
      }
      setValue("");
      onAttachmentsChange?.([]);
    },
    [value, onSubmit, atts, onAttachmentsChange],
  );

  return (
    <PromptInputContext.Provider value={{ value, setValue }}>
      <form
        className={cn("w-full", className)}
        onSubmit={handleSubmit}
        {...props}
      >
        <div className="surface-sunken relative flex flex-col rounded-lg">
          {children}
        </div>
      </form>
    </PromptInputContext.Provider>
  );
};

// ============================================================================
// PromptInputBody
// ============================================================================

export type PromptInputBodyProps = HTMLAttributes<HTMLDivElement>;

export const PromptInputBody = ({
  className,
  ...props
}: PromptInputBodyProps) => (
  <div className={cn("contents", className)} {...props} />
);

// ============================================================================
// PromptInputTextarea
// ============================================================================

export type PromptInputTextareaProps = Omit<
  TextareaHTMLAttributes<HTMLTextAreaElement>,
  "value"
> & {
  value?: string;
  onChange?: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
};

export const PromptInputTextarea = ({
  className,
  placeholder = "What would you like to know?",
  onChange,
  value: externalValue,
  onKeyDown,
  ...props
}: PromptInputTextareaProps) => {
  const ctx = useContext(PromptInputContext);
  const [isComposing, setIsComposing] = useState(false);

  // 将外部值同步到 context,使 PromptInput.handleSubmit 读取到正确的值
  useEffect(() => {
    if (externalValue !== undefined && ctx) {
      ctx.setValue(externalValue);
    }
  }, [externalValue, ctx]);

  const currentValue = externalValue ?? ctx?.value ?? "";

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      ctx?.setValue(e.target.value);
      onChange?.(e);
    },
    [ctx, onChange],
  );

  const handleKeyDown: KeyboardEventHandler<HTMLTextAreaElement> = useCallback(
    (e) => {
      onKeyDown?.(e);
      if (e.defaultPrevented) return;

      if (e.key === "Enter") {
        if (isComposing || e.nativeEvent.isComposing) return;
        if (e.shiftKey) return;
        e.preventDefault();
        const { form } = e.currentTarget;
        const submitBtn = form?.querySelector(
          'button[type="submit"]',
        ) as HTMLButtonElement | null;
        if (submitBtn?.disabled) return;
        form?.requestSubmit();
      }
    },
    [onKeyDown, isComposing],
  );

  return (
    <textarea
      className={cn(
        "field-sizing-content max-h-48 min-h-16 w-full resize-none bg-transparent px-2 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none",
        className,
      )}
      value={currentValue}
      onChange={handleChange}
      onKeyDown={handleKeyDown}
      onCompositionStart={() => setIsComposing(true)}
      onCompositionEnd={() => setIsComposing(false)}
      placeholder={placeholder}
      {...props}
    />
  );
};

// ============================================================================
// PromptInputHeader
// ============================================================================

export type PromptInputHeaderProps = HTMLAttributes<HTMLDivElement>;

export const PromptInputHeader = ({
  className,
  ...props
}: PromptInputHeaderProps) => (
  <div className={cn("flex flex-wrap gap-1 px-3 pt-2", className)} {...props} />
);

// ============================================================================
// PromptInputFooter
// ============================================================================

export type PromptInputFooterProps = HTMLAttributes<HTMLDivElement>;

export const PromptInputFooter = ({
  className,
  ...props
}: PromptInputFooterProps) => (
  <div
    className={cn(
      "flex items-center justify-between gap-1 px-3 py-2",
      className,
    )}
    {...props}
  />
);

// ============================================================================
// PromptInputTools
// ============================================================================

export type PromptInputToolsProps = HTMLAttributes<HTMLDivElement>;

export const PromptInputTools = ({
  className,
  ...props
}: PromptInputToolsProps) => (
  <div
    className={cn("flex min-w-0 items-center gap-1", className)}
    {...props}
  />
);

// ============================================================================
// PromptInputSubmit
// ============================================================================

type ChatStatus = "submitted" | "streaming" | "ready" | "error";

export type PromptInputSubmitProps = HTMLAttributes<HTMLButtonElement> & {
  disabled?: boolean;
  status?: ChatStatus;
  onStop?: () => void;
};

export const PromptInputSubmit = ({
  className,
  disabled,
  status,
  onStop,
  ...props
}: PromptInputSubmitProps) => {
  const isActive = status === "submitted" || status === "streaming";

  return (
    <button
      {...props}
      type={isActive ? "button" : "submit"}
      disabled={disabled}
      className={cn(
        "inline-flex items-center justify-center rounded-md p-2 transition-all",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        "disabled:opacity-50 disabled:cursor-not-allowed",
        isActive
          ? "text-muted-foreground hover:bg-accent hover:text-foreground"
          : "bg-primary text-primary-foreground hover:bg-primary-bright active:scale-95",
        className,
      )}
      aria-label={isActive ? "Stop" : "Send"}
      onClick={
        isActive
          ? (e) => {
              e.preventDefault();
              onStop?.();
            }
          : undefined
      }
    >
      {isActive ? (
        <SquareIcon className="size-4 fill-current" />
      ) : (
        <CornerDownLeftIcon className="size-4" />
      )}
    </button>
  );
};

// ============================================================================
// PromptInputAttachButton
// ============================================================================

export type PromptInputAttachButtonProps = HTMLAttributes<HTMLButtonElement> & {
  disabled?: boolean;
};

export const PromptInputAttachButton = ({
  className,
  disabled,
  "aria-label": ariaLabel = "Attach files",
  ...props
}: PromptInputAttachButtonProps) => (
  <button
    type="button"
    {...props}
    disabled={disabled}
    aria-label={ariaLabel}
    className={cn(
      "inline-flex items-center justify-center rounded-md p-2 transition-all active:scale-95",
      "text-muted-foreground hover:text-foreground hover:bg-accent",
      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
      "disabled:opacity-50 disabled:cursor-not-allowed",
      className,
    )}
  >
    <PaperclipIcon className="size-4" />
  </button>
);
