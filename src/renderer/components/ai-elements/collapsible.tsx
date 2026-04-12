import {
  type ButtonHTMLAttributes,
  createContext,
  type HTMLAttributes,
  useContext,
  useState,
} from "react";

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
    return (
      <button
        type="button"
        onClick={() => onOpenChange(!open)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onOpenChange(!open);
        }}
        {...props}
      >
        {children}
      </button>
    );
  }

  return (
    <button type="button" onClick={() => onOpenChange(!open)}>
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
    <div className={className} {...props}>
      {children}
    </div>
  );
};
