import { CornerDownLeftIcon, SquareIcon } from "lucide-react";
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
import { cn } from "../../lib/utils";

// ============================================================================
// Context — carries the textarea value so PromptInput can read it on submit
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
}

export type PromptInputProps = Omit<
  HTMLAttributes<HTMLFormElement>,
  "onSubmit"
> & {
  onSubmit: (message: PromptInputMessage) => void | Promise<void>;
};

export const PromptInput = ({
  className,
  onSubmit,
  children,
  ...props
}: PromptInputProps) => {
  const [value, setValue] = useState("");

  const handleSubmit = useCallback(
    async (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      if (!value.trim()) return;
      const result = onSubmit({ text: value });
      if (result instanceof Promise) {
        await result;
      }
      setValue("");
    },
    [value, onSubmit],
  );

  return (
    <PromptInputContext.Provider value={{ value, setValue }}>
      <form
        className={cn("w-full", className)}
        onSubmit={handleSubmit}
        {...props}
      >
        <div className="relative flex flex-col rounded-lg border border-border bg-muted">
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

  // Sync external value into context so PromptInput.handleSubmit reads the right value
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
        "inline-flex items-center justify-center rounded-md p-2 transition-colors",
        "text-muted-foreground hover:text-foreground hover:bg-accent",
        "disabled:opacity-50 disabled:cursor-not-allowed",
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
