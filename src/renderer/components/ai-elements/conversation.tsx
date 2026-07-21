import { ArrowDown, Download } from "lucide-react";
import {
  createContext,
  type HTMLAttributes,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
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
  shouldStickToBottomRef: { current: boolean };
  lastScrollTopRef: { current: number };
  canScroll: boolean;
  isAtBottom: boolean;
  setCanScroll: (v: boolean) => void;
  setIsAtBottom: (v: boolean) => void;
  scrollToBottom: () => void;
}

const ConversationContext = createContext<ConversationContextType>({
  scrollRef: { current: null },
  shouldStickToBottomRef: { current: true },
  lastScrollTopRef: { current: 0 },
  canScroll: false,
  isAtBottom: true,
  setCanScroll: () => {},
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
  const shouldStickToBottomRef = useRef(true);
  const lastScrollTopRef = useRef(0);
  const [canScroll, setCanScroll] = useState(false);
  const [isAtBottom, setIsAtBottom] = useState(true);

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    shouldStickToBottomRef.current = true;
    lastScrollTopRef.current = el.scrollTop;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, []);

  return (
    <ConversationContext.Provider
      value={{
        scrollRef,
        shouldStickToBottomRef,
        lastScrollTopRef,
        canScroll,
        isAtBottom,
        setCanScroll,
        setIsAtBottom,
        scrollToBottom,
      }}
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
  extends HTMLAttributes<HTMLDivElement> {
  /** Changing this key is an explicit request to resume following the newest
   * message, even when the reader previously scrolled up through history. */
  scrollToBottomKey?: string | number | null;
}

export const ConversationContent = ({
  children,
  className,
  scrollToBottomKey,
  ...props
}: ConversationContentProps) => {
  const {
    scrollRef,
    shouldStickToBottomRef,
    lastScrollTopRef,
    setCanScroll,
    setIsAtBottom,
    scrollToBottom,
  } = useConversation();
  const updateScrollState = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const threshold = 40;
    const maxScrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
    const hasScrollableOverflow = maxScrollTop > threshold;
    setCanScroll(hasScrollableOverflow);
    setIsAtBottom(
      shouldStickToBottomRef.current ||
        !hasScrollableOverflow ||
        maxScrollTop - el.scrollTop < threshold,
    );
  }, [scrollRef, setCanScroll, setIsAtBottom, shouldStickToBottomRef]);

  // Track child count to auto-scroll on new messages
  const prevChildCountRef = useRef(0);
  const prevScrollToBottomKeyRef = useRef(scrollToBottomKey);
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

  useEffect(() => {
    const changed = scrollToBottomKey !== prevScrollToBottomKeyRef.current;
    prevScrollToBottomKeyRef.current = scrollToBottomKey;
    if (changed && scrollToBottomKey != null) {
      scrollToBottom();
    }
  }, [scrollToBottom, scrollToBottomKey]);

  // Keep overflow and bottom state in sync with layout changes.
  useLayoutEffect(() => {
    updateScrollState();
  });

  // Observe scroll position to toggle "at bottom" state
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const handleScroll = () => {
      const threshold = 40;
      const maxScrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
      const atBottom =
        maxScrollTop <= threshold || maxScrollTop - el.scrollTop < threshold;

      if (atBottom) {
        shouldStickToBottomRef.current = true;
      } else if (el.scrollTop <= lastScrollTopRef.current) {
        shouldStickToBottomRef.current = false;
      }
      lastScrollTopRef.current = el.scrollTop;
      updateScrollState();
    };
    el.addEventListener("scroll", handleScroll, { passive: true });
    return () => el.removeEventListener("scroll", handleScroll);
  }, [lastScrollTopRef, scrollRef, shouldStickToBottomRef, updateScrollState]);

  // MutationObserver – auto-scroll while streaming if user is near bottom
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const observer = new MutationObserver(() => {
      if (shouldStickToBottomRef.current) {
        scrollToBottom();
      }
      updateScrollState();
    });
    observer.observe(el, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    return () => observer.disconnect();
  }, [scrollRef, scrollToBottom, shouldStickToBottomRef, updateScrollState]);

  return (
    <div
      ref={scrollRef}
      className={cn(
        "flex-1 overflow-y-auto scroll-smooth px-6 py-4",
        className,
      )}
      {...props}
    >
      <div className="space-y-4 max-w-3xl mx-auto">{children}</div>
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
  const { canScroll, isAtBottom, scrollToBottom } = useConversation();

  if (!canScroll || isAtBottom) return null;

  return (
    <Button
      type="button"
      onClick={scrollToBottom}
      variant="ghost"
      size="icon"
      className={cn(
        "absolute bottom-4 left-1/2 z-10 -translate-x-1/2",
        "size-9 rounded-full border border-border/60 bg-background/85 text-muted-foreground shadow-lg shadow-black/10 backdrop-blur-md",
        "hover:border-border hover:bg-background hover:text-foreground active:scale-95 dark:bg-background/75",
        className,
      )}
      aria-label={LL.conv_scrollToBottom()}
      title={LL.conv_scrollToBottom()}
      {...props}
    >
      <ArrowDown className="size-4" aria-hidden="true" />
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
