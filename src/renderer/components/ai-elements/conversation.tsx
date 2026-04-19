import { ArrowDown, Download } from "lucide-react";
import {
  createContext,
  type HTMLAttributes,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { useI18nContext } from "../../i18n/i18n-react";
import { cn } from "../../lib/utils";

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

interface ConversationContextType {
  scrollRef: React.RefObject<HTMLDivElement | null>;
  isAtBottom: boolean;
  setIsAtBottom: (v: boolean) => void;
  scrollToBottom: () => void;
}

const ConversationContext = createContext<ConversationContextType>({
  scrollRef: { current: null },
  isAtBottom: true,
  setIsAtBottom: () => {},
  scrollToBottom: () => {},
});

const useConversation = () => useContext(ConversationContext);

// ---------------------------------------------------------------------------
// <Conversation />
// ---------------------------------------------------------------------------

export interface ConversationProps extends HTMLAttributes<HTMLDivElement> {}

export const Conversation = ({
  children,
  className,
  ...props
}: ConversationProps) => {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, []);

  return (
    <ConversationContext.Provider
      value={{ scrollRef, isAtBottom, setIsAtBottom, scrollToBottom }}
    >
      <div
        className={cn(
          "relative flex flex-1 flex-col overflow-hidden",
          className,
        )}
        role="log"
        aria-live="polite"
        {...props}
      >
        {children}
      </div>
    </ConversationContext.Provider>
  );
};

// ---------------------------------------------------------------------------
// <ConversationContent />
// ---------------------------------------------------------------------------

export interface ConversationContentProps
  extends HTMLAttributes<HTMLDivElement> {}

export const ConversationContent = ({
  children,
  className,
  ...props
}: ConversationContentProps) => {
  const { scrollRef, setIsAtBottom, scrollToBottom } = useConversation();

  // Track child count to auto-scroll on new messages
  const prevChildCountRef = useRef(0);
  const childCount = Array.isArray(children)
    ? children.length
    : children
      ? 1
      : 0;

  useEffect(() => {
    if (childCount > prevChildCountRef.current) {
      scrollToBottom();
    }
    prevChildCountRef.current = childCount;
  }, [childCount, scrollToBottom]);

  // Observe scroll position to toggle "at bottom" state
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const handleScroll = () => {
      const threshold = 40;
      const atBottom =
        el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
      setIsAtBottom(atBottom);
    };
    el.addEventListener("scroll", handleScroll, { passive: true });
    return () => el.removeEventListener("scroll", handleScroll);
  }, [scrollRef, setIsAtBottom]);

  // MutationObserver – auto-scroll while streaming if user is near bottom
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const observer = new MutationObserver(() => {
      const threshold = 40;
      const nearBottom =
        el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
      if (nearBottom) {
        el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
      }
    });
    observer.observe(el, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    return () => observer.disconnect();
  }, [scrollRef]);

  return (
    <div
      ref={scrollRef}
      className={cn(
        "flex-1 overflow-y-auto scroll-smooth px-6 py-4",
        className,
      )}
      {...props}
    >
      <div className="space-y-4 max-w-2xl mx-auto">{children}</div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// <ConversationEmptyState />
// ---------------------------------------------------------------------------

export interface ConversationEmptyStateProps
  extends HTMLAttributes<HTMLDivElement> {
  icon?: ReactNode;
  title?: string;
  description?: string;
}

export const ConversationEmptyState = ({
  icon,
  title,
  description,
  children,
  className,
  ...props
}: ConversationEmptyStateProps) => (
  <div
    className={cn(
      "flex flex-col items-center justify-center h-full gap-4 text-center",
      className,
    )}
    {...props}
  >
    {icon && <div className="text-muted-foreground">{icon}</div>}
    {title && <h2 className="text-lg font-medium text-foreground">{title}</h2>}
    {description && (
      <p className="text-sm text-muted-foreground">{description}</p>
    )}
    {children}
  </div>
);

// ---------------------------------------------------------------------------
// <ConversationScrollButton />
// ---------------------------------------------------------------------------

export interface ConversationScrollButtonProps
  extends HTMLAttributes<HTMLButtonElement> {}

export const ConversationScrollButton = ({
  className,
  ...props
}: ConversationScrollButtonProps) => {
  const { LL } = useI18nContext();
  const { isAtBottom, scrollToBottom } = useConversation();

  if (isAtBottom) return null;

  return (
    <button
      type="button"
      onClick={scrollToBottom}
      className={cn(
        "absolute bottom-20 left-1/2 -translate-x-1/2 z-10",
        "flex items-center gap-1.5 rounded-full border border-border bg-background/90 backdrop-blur-sm",
        "px-3 py-1.5 text-xs text-muted-foreground shadow-md",
        "hover:bg-accent hover:text-foreground transition-colors",
        className,
      )}
      aria-label={LL.conv_scrollToBottom()}
      {...props}
    >
      <ArrowDown className="size-3" />
      <span>{LL.conv_newMessages()}</span>
    </button>
  );
};

// ---------------------------------------------------------------------------
// <ConversationDownload />
// ---------------------------------------------------------------------------

interface DownloadMessage {
  role: string;
  content?: string;
  parts?: { type: string; text?: string }[];
}

export const messagesToMarkdown = (
  messages: DownloadMessage[],
  roleLabels: { user: string; assistant: string },
  formatter?: (msg: DownloadMessage, index: number) => string,
): string =>
  messages
    .map((msg, i) => {
      if (formatter) return formatter(msg, i);
      const role = msg.role === "user" ? roleLabels.user : roleLabels.assistant;
      const text =
        msg.parts
          ?.filter((p) => p.type === "text" && p.text)
          .map((p) => p.text)
          .join("\n") ??
        msg.content ??
        "";
      return `### ${role}\n\n${text}`;
    })
    .join("\n\n---\n\n");

export interface ConversationDownloadProps
  extends HTMLAttributes<HTMLButtonElement> {
  messages: DownloadMessage[];
  filename?: string;
}

export const ConversationDownload = ({
  messages,
  filename = "conversation.md",
  className,
  ...props
}: ConversationDownloadProps) => {
  const { LL } = useI18nContext();
  const handleDownload = () => {
    const md = messagesToMarkdown(messages, {
      user: LL.conv_roleUser(),
      assistant: LL.conv_roleAssistant(),
    });
    const blob = new Blob([md], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (messages.length === 0) return null;

  return (
    <button
      type="button"
      onClick={handleDownload}
      className={cn(
        "absolute top-2 right-2 z-10",
        "flex items-center gap-1.5 rounded-md border border-border bg-background/80 backdrop-blur-sm",
        "px-2 py-1 text-xs text-muted-foreground",
        "hover:bg-accent hover:text-foreground transition-colors",
        "opacity-0 group-hover:opacity-100",
        className,
      )}
      aria-label={LL.conv_download()}
      {...props}
    >
      <Download className="size-3" />
    </button>
  );
};
