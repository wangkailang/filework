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

export type MessageContentProps = HTMLAttributes<HTMLDivElement>;

export const MessageContent = ({
  children,
  className,
  ...props
}: MessageContentProps) => (
  <div
    className={cn(
      "flex w-fit min-w-0 max-w-full flex-col gap-2 overflow-hidden text-sm",
      "group-[.is-user]:ml-auto group-[.is-user]:rounded-lg group-[.is-user]:bg-secondary group-[.is-user]:px-4 group-[.is-user]:py-3 group-[.is-user]:text-foreground",
      "group-[.is-assistant]:text-foreground",
      className,
    )}
    {...props}
  >
    {children}
  </div>
);

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
    >
      {children}
    </a>
  );
}

export const MessageResponse = memo(
  ({ className, ...props }: MessageResponseProps) => {
    // Built per-render so each <a> can call useLinkRouter (a hook).
    const components = useMemo<ComponentProps<typeof Streamdown>["components"]>(
      () => ({ code: MarkdownCodeBlock, a: RoutedAnchor }),
      [],
    );
    return (
      <Streamdown
        className={cn(
          "size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
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
