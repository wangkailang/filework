import { cjk } from "@streamdown/cjk";
import { math } from "@streamdown/math";
import type {
  AnchorHTMLAttributes,
  ComponentProps,
  HTMLAttributes,
} from "react";
import { memo, useMemo } from "react";
import { Streamdown } from "streamdown";
import { cn } from "../../lib/utils";
import { useLinkRouter } from "../browser/useLinkRouter";
import { MarkdownCodeBlock } from "./markdown-code-block";

export type MessageProps = HTMLAttributes<HTMLDivElement> & {
  from: "user" | "assistant";
};

export const Message = ({ className, from, ...props }: MessageProps) => (
  <div
    className={cn(
      "group flex w-full max-w-[95%] flex-col gap-2",
      from === "user" ? "is-user ml-auto justify-end" : "is-assistant",
      className,
    )}
    {...props}
  />
);

export type MessageActionFrameProps = HTMLAttributes<HTMLDivElement> & {
  from: "user" | "assistant";
};

export const MessageActionFrame = ({
  className,
  from,
  ...props
}: MessageActionFrameProps) => (
  <div
    className={cn(
      "group/message-actions relative flex max-w-[95%] flex-col after:pointer-events-auto after:absolute after:top-full after:right-0 after:h-8 after:w-full after:min-w-16 after:content-['']",
      from === "user" ? "ml-auto w-fit items-end" : "w-full",
      className,
    )}
    {...props}
  />
);

export type MessageContentProps = HTMLAttributes<HTMLDivElement>;

export const MessageContent = ({
  children,
  className,
  ...props
}: MessageContentProps) => (
  <div
    className={cn(
      // 用户气泡贴合文字(w-fit);助手满宽(w-full)给一个确定宽度的祖先,
      // 否则工具卡里 truncate 的长 URL 会反撑 w-fit、省略号永不触发。
      "flex min-w-0 max-w-full flex-col gap-1 overflow-hidden text-sm",
      "group-[.is-user]:ml-auto group-[.is-user]:w-fit group-[.is-user]:rounded-lg group-[.is-user]:bg-secondary group-[.is-user]:px-4 group-[.is-user]:py-3 group-[.is-user]:text-foreground",
      "group-[.is-assistant]:w-full group-[.is-assistant]:text-foreground",
      className,
    )}
    {...props}
  >
    {children}
  </div>
);

type SkillTextPart =
  | { id: string; key: string; text: string; type: "skill" }
  | { key: string; text: string; type: "text" };

const leadingSkillPattern = /^\/([A-Za-z0-9][A-Za-z0-9._:-]*)(?=\s|$)/;

export const splitLeadingSkillMentions = (text: string): SkillTextPart[] => {
  const parts: SkillTextPart[] = [];
  let index = 0;

  while (index < text.length) {
    const skillMatch = leadingSkillPattern.exec(text.slice(index));
    if (!skillMatch) break;

    const skillStart = index;
    parts.push({
      id: skillMatch[1],
      key: `skill-${skillStart}-${skillMatch[0]}`,
      text: skillMatch[1],
      type: "skill",
    });
    index += skillMatch[0].length;

    const whitespaceMatch = /^\s+/.exec(text.slice(index));
    if (!whitespaceMatch) continue;

    const whitespaceStart = index;
    index += whitespaceMatch[0].length;
    if (/[\r\n]/.test(whitespaceMatch[0])) {
      parts.push({
        key: `text-${whitespaceStart}`,
        text: whitespaceMatch[0],
        type: "text",
      });
    }
  }

  if (parts.length === 0) return [{ key: "text-0", text, type: "text" }];
  if (index < text.length)
    parts.push({ key: `text-${index}`, text: text.slice(index), type: "text" });
  return parts;
};

export type MessageSkillTextProps = {
  className?: string;
  text: string;
};

export const MessageSkillText = ({
  className,
  text,
}: MessageSkillTextProps) => {
  const parts = useMemo(() => splitLeadingSkillMentions(text), [text]);

  return (
    <div className={cn("whitespace-pre-wrap break-words", className)}>
      {parts.map((part) =>
        part.type === "skill" ? (
          <span
            className="prompt-skill-mention"
            data-skill-id={part.id}
            data-skill-mention=""
            key={part.key}
          >
            {part.text}
          </span>
        ) : (
          <span key={part.key}>{part.text}</span>
        ),
      )}
    </div>
  );
};

export type MessageActionsProps = ComponentProps<"div">;

export const MessageActions = ({
  className,
  children,
  ...props
}: MessageActionsProps) => (
  <div className={cn("flex items-center gap-1", className)} {...props}>
    {children}
  </div>
);

export const messageActionsHoverClass =
  "pointer-events-none absolute top-full right-0 z-20 -translate-y-1/2 rounded-lg border border-border/60 bg-background/95 p-0.5 shadow-sm opacity-0 transition-opacity group-hover/message-actions:pointer-events-auto group-hover/message-actions:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100";

export type MessageActionProps = HTMLAttributes<HTMLButtonElement> & {
  label?: string;
};

export const MessageAction = ({
  children,
  label,
  className,
  ...props
}: MessageActionProps) => (
  <button
    type="button"
    className={cn(
      "inline-flex items-center justify-center rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors",
      className,
    )}
    aria-label={label}
    {...props}
  >
    {children}
  </button>
);

export type MessageResponseProps = ComponentProps<typeof Streamdown>;

const streamdownPlugins = { cjk, math };

const streamdownControls: ComponentProps<typeof Streamdown>["controls"] = {
  table: true,
  code: false,
  mermaid: true,
};

function RoutedAnchor({
  children,
  href,
  className,
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement>) {
  const link = useLinkRouter();
  return (
    <a
      {...props}
      href={href}
      onClick={link.onClick}
      onAuxClick={link.onAuxClick}
      rel="noopener noreferrer"
      className={cn(
        // 主色链接:下划线带 offset、hover 加深;长 URL 可断行不撑破气泡。
        "cursor-pointer break-words font-medium text-primary underline decoration-primary/40 underline-offset-2 transition-colors hover:text-primary/80 hover:decoration-primary/70",
        className,
      )}
    >
      {children}
    </a>
  );
}

type MarkdownElementProps<T extends keyof React.JSX.IntrinsicElements> =
  ComponentProps<T> & { node?: unknown };

function ChatTable({
  children,
  className,
  node: _node,
  ...props
}: MarkdownElementProps<"table">) {
  return (
    <div
      data-chat-table-scroll="true"
      className="my-2.5 max-w-full overflow-x-auto"
    >
      <table
        {...props}
        data-chat-table="true"
        className={cn(
          "w-full min-w-max border-collapse text-left text-[13px] leading-relaxed",
          className,
        )}
      >
        {children}
      </table>
    </div>
  );
}

function ChatTableHead({
  className,
  node: _node,
  ...props
}: MarkdownElementProps<"thead">) {
  return (
    <thead {...props} className={cn("border-border/70 border-b", className)} />
  );
}

function ChatTableBody({
  className,
  node: _node,
  ...props
}: MarkdownElementProps<"tbody">) {
  return (
    <tbody
      {...props}
      className={cn("[&>tr:last-child>td]:border-b-0", className)}
    />
  );
}

function ChatTableRow({
  className,
  node: _node,
  ...props
}: MarkdownElementProps<"tr">) {
  return <tr {...props} className={cn(className)} />;
}

function ChatTableHeaderCell({
  className,
  node: _node,
  ...props
}: MarkdownElementProps<"th">) {
  return (
    <th
      {...props}
      className={cn(
        "whitespace-nowrap px-0 py-1.5 pr-8 text-left font-semibold text-foreground align-bottom last:pr-0",
        className,
      )}
    />
  );
}

function ChatTableCell({
  className,
  node: _node,
  ...props
}: MarkdownElementProps<"td">) {
  return (
    <td
      {...props}
      className={cn(
        "border-border/45 border-b px-0 py-2 pr-8 text-foreground/90 align-top last:pr-0",
        className,
      )}
    />
  );
}

function ChatParagraph({
  className,
  node: _node,
  ...props
}: MarkdownElementProps<"p">) {
  return (
    <p
      {...props}
      className={cn("my-2 leading-7 text-foreground/95", className)}
    />
  );
}

function ChatHeading1({
  className,
  node: _node,
  ...props
}: MarkdownElementProps<"h1">) {
  return (
    <h1
      {...props}
      data-chat-heading="h1"
      className={cn(
        "mt-5 mb-2 text-[1.35rem] leading-snug font-semibold tracking-normal text-foreground",
        className,
      )}
    />
  );
}

function ChatHeading2({
  className,
  node: _node,
  ...props
}: MarkdownElementProps<"h2">) {
  return (
    <h2
      {...props}
      data-chat-heading="h2"
      className={cn(
        "mt-4 mb-2 text-[1.18rem] leading-snug font-semibold tracking-normal text-foreground",
        className,
      )}
    />
  );
}

function ChatHeading3({
  className,
  node: _node,
  ...props
}: MarkdownElementProps<"h3">) {
  return (
    <h3
      {...props}
      data-chat-heading="h3"
      className={cn(
        "mt-3.5 mb-1.5 text-[1.05rem] leading-snug font-semibold tracking-normal text-foreground",
        className,
      )}
    />
  );
}

function ChatHeading4({
  className,
  node: _node,
  ...props
}: MarkdownElementProps<"h4">) {
  return (
    <h4
      {...props}
      data-chat-heading="h4"
      className={cn(
        "mt-3 mb-1 text-[0.98rem] leading-snug font-semibold tracking-normal text-foreground",
        className,
      )}
    />
  );
}

function ChatHeading5({
  className,
  node: _node,
  ...props
}: MarkdownElementProps<"h5">) {
  return (
    <h5
      {...props}
      data-chat-heading="h5"
      className={cn(
        "mt-3 mb-1 text-[0.92rem] leading-snug font-semibold tracking-normal text-foreground/95",
        className,
      )}
    />
  );
}

function ChatHeading6({
  className,
  node: _node,
  ...props
}: MarkdownElementProps<"h6">) {
  return (
    <h6
      {...props}
      data-chat-heading="h6"
      className={cn(
        "mt-3 mb-1 text-[0.86rem] leading-snug font-semibold tracking-normal text-muted-foreground",
        className,
      )}
    />
  );
}

function ChatUnorderedList({
  className,
  node: _node,
  ...props
}: MarkdownElementProps<"ul">) {
  return (
    <ul
      {...props}
      className={cn("my-2.5 list-disc space-y-1 pl-5 leading-7", className)}
    />
  );
}

function ChatOrderedList({
  className,
  node: _node,
  ...props
}: MarkdownElementProps<"ol">) {
  return (
    <ol
      {...props}
      className={cn("my-2.5 list-decimal space-y-1 pl-5 leading-7", className)}
    />
  );
}

function ChatListItem({
  className,
  node: _node,
  ...props
}: MarkdownElementProps<"li">) {
  return (
    <li
      {...props}
      className={cn(
        "pl-1 text-foreground/95 marker:text-muted-foreground [&>p]:my-1 [&>ol]:my-1 [&>ul]:my-1",
        className,
      )}
    />
  );
}

function ChatBlockquote({
  className,
  node: _node,
  ...props
}: MarkdownElementProps<"blockquote">) {
  return (
    <blockquote
      {...props}
      className={cn(
        "my-3 border-l-2 border-border-strong/70 pl-3 text-muted-foreground [&>p]:my-1.5",
        className,
      )}
    />
  );
}

function ChatHorizontalRule({
  className,
  node: _node,
  ...props
}: MarkdownElementProps<"hr">) {
  return <hr {...props} className={cn("my-4 border-border/55", className)} />;
}

function ChatStrong({
  className,
  node: _node,
  ...props
}: MarkdownElementProps<"strong">) {
  return (
    <strong
      {...props}
      className={cn("font-semibold text-foreground", className)}
    />
  );
}

export const MessageResponse = memo(
  ({ className, ...props }: MessageResponseProps) => {
    // Built per-render so each <a> can call useLinkRouter (a hook).
    const components = useMemo<ComponentProps<typeof Streamdown>["components"]>(
      () => ({
        code: MarkdownCodeBlock,
        a: RoutedAnchor,
        table: ChatTable,
        thead: ChatTableHead,
        tbody: ChatTableBody,
        tr: ChatTableRow,
        th: ChatTableHeaderCell,
        td: ChatTableCell,
        p: ChatParagraph,
        h1: ChatHeading1,
        h2: ChatHeading2,
        h3: ChatHeading3,
        h4: ChatHeading4,
        h5: ChatHeading5,
        h6: ChatHeading6,
        ul: ChatUnorderedList,
        ol: ChatOrderedList,
        li: ChatListItem,
        blockquote: ChatBlockquote,
        hr: ChatHorizontalRule,
        strong: ChatStrong,
      }),
      [],
    );
    return (
      <Streamdown
        className={cn(
          "size-full break-words text-[15px] leading-7 text-foreground/95 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
          className,
        )}
        plugins={streamdownPlugins}
        controls={streamdownControls}
        components={components}
        {...props}
      />
    );
  },
  (prevProps, nextProps) => prevProps.children === nextProps.children,
);

MessageResponse.displayName = "MessageResponse";
