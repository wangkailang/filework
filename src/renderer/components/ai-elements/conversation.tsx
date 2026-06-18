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
import { Button } from "../ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../ui/empty";

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
  <Empty
    className={cn("h-full rounded-none border-none bg-transparent", className)}
    {...props}
  >
    <EmptyHeader>
      {icon && <EmptyMedia variant="icon">{icon}</EmptyMedia>}
      {title && <EmptyTitle className="text-lg">{title}</EmptyTitle>}
      {description && <EmptyDescription>{description}</EmptyDescription>}
    </EmptyHeader>
    {children && <EmptyContent>{children}</EmptyContent>}
  </Empty>
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
    <Button
      type="button"
      onClick={scrollToBottom}
      variant="outline"
      size="sm"
      className={cn(
        "absolute bottom-20 left-1/2 -translate-x-1/2 z-10",
        "rounded-full bg-background/90 text-muted-foreground shadow-md backdrop-blur-sm",
        className,
      )}
      aria-label={LL.conv_scrollToBottom()}
      {...props}
    >
      <ArrowDown data-icon="inline-start" />
      <span>{LL.conv_newMessages()}</span>
    </Button>
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
    <Button
      type="button"
      onClick={handleDownload}
      variant="outline"
      size="icon-sm"
      className={cn(
        "absolute top-2 right-2 z-10",
        "bg-background/80 text-muted-foreground opacity-0 backdrop-blur-sm group-hover:opacity-100",
        className,
      )}
      aria-label={LL.conv_download()}
      {...props}
    >
      <Download />
    </Button>
  );
};
