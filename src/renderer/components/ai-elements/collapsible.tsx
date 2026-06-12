import {
  type ButtonHTMLAttributes,
  createContext,
  type HTMLAttributes,
  useContext,
  useState,
} from "react";
import { cn } from "../../lib/utils";

interface CollapsibleContextType {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const CollapsibleContext = createContext<CollapsibleContextType>({
  open: false,
  onOpenChange: () => {},
});

interface CollapsibleProps extends HTMLAttributes<HTMLDivElement> {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export const Collapsible = ({
  open = false,
  onOpenChange,
  children,
  className,
  ...props
}: CollapsibleProps) => {
  const [internalOpen, setInternalOpen] = useState(open);
  const isOpen = open ?? internalOpen;
  const handleChange = onOpenChange ?? setInternalOpen;

  return (
    <CollapsibleContext.Provider
      value={{ open: isOpen, onOpenChange: handleChange }}
    >
      <div className={className} {...props}>
        {children}
      </div>
    </CollapsibleContext.Provider>
  );
};

interface CollapsibleTriggerProps
  extends ButtonHTMLAttributes<HTMLButtonElement> {
  asChild?: boolean;
}

export const CollapsibleTrigger = ({
  children,
  asChild,
  ...props
}: CollapsibleTriggerProps) => {
  const { open, onOpenChange } = useContext(CollapsibleContext);

  if (asChild) {
    const { className, ...rest } = props;
    return (
      <button
        type="button"
        onClick={() => onOpenChange(!open)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onOpenChange(!open);
        }}
        // 内容被包进真实 <button>,而 button 的 UA 样式是 text-align:center,
        // 会被里面的 flex 子项继承,导致工具行文本整体居中。强制左对齐。
        className={cn("text-left", className)}
        {...rest}
      >
        {children}
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={() => onOpenChange(!open)}
      className="text-left"
    >
      {children}
    </button>
  );
};

interface CollapsibleContentProps extends HTMLAttributes<HTMLDivElement> {}

export const useCollapsible = () => useContext(CollapsibleContext);

export const CollapsibleContent = ({
  children,
  className,
  ...props
}: CollapsibleContentProps) => {
  const { open } = useContext(CollapsibleContext);
  if (!open) return null;
  return (
    <div
      className={cn(
        "animate-in fade-in-0 slide-in-from-top-1 duration-200",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
};
