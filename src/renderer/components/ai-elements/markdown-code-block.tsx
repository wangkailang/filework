import { Check, Copy } from "lucide-react";
import {
  type HTMLAttributes,
  memo,
  type ReactNode,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { ExtraProps } from "streamdown";
// hljs 配置(语言注册、别名、转义)集中在 lib/highlight,与文件预览共用。
import { escapeHtml, hljs, LANG_ALIAS } from "../../lib/highlight";
import { cn } from "../../lib/utils";

const LANG_DISPLAY: Record<string, string> = {
  csharp: "c#",
  cpp: "c++",
  bash: "shell",
  xml: "html",
};

type CodeProps = HTMLAttributes<HTMLElement> &
  ExtraProps & {
    children?: ReactNode;
  };

const childrenToString = (children: ReactNode): string => {
  if (typeof children === "string") return children;
  if (typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map(childrenToString).join("");
  return "";
};

export const MarkdownCodeBlock = ({
  className,
  children,
  ...props
}: CodeProps) => {
  const raw = childrenToString(children).replace(/\n$/, "");
  const isBlock = "data-block" in props || raw.includes("\n");

  if (!isBlock) {
    return (
      <code
        className={cn(
          "rounded bg-muted px-1.5 py-0.5 font-mono text-sm",
          className,
        )}
        data-streamdown="inline-code"
      >
        {children}
      </code>
    );
  }

  const rawLang = (
    className?.match(/language-([\w+-]+)/)?.[1] ?? ""
  ).toLowerCase();
  const resolved = rawLang ? (LANG_ALIAS[rawLang] ?? rawLang) : "plaintext";
  return <HighlightedBlock raw={raw} resolved={resolved} />;
};

const HighlightedBlock = memo(
  ({ raw, resolved }: { raw: string; resolved: string }) => {
    const display = LANG_DISPLAY[resolved] ?? resolved;
    const html = useMemo(
      () =>
        hljs.getLanguage(resolved)
          ? hljs.highlight(raw, { language: resolved, ignoreIllegals: true })
              .value
          : escapeHtml(raw),
      [raw, resolved],
    );

    return (
      <div
        className="my-3 overflow-hidden rounded-lg border border-border bg-card"
        data-streamdown="code-block"
        data-language={resolved}
      >
        <div
          className="relative flex h-8 items-center border-b border-border bg-muted/50 px-3"
          data-streamdown="code-block-header"
        >
          <span className="font-mono text-xs lowercase text-muted-foreground">
            {display}
          </span>
          <CopyButton raw={raw} />
        </div>
        <pre className="m-0 overflow-x-auto p-4 text-sm leading-relaxed">
          <code
            className={`hljs language-${resolved}`}
            // biome-ignore lint/security/noDangerouslySetInnerHtml: hljs escapes input HTML; output is sanitized token markup
            dangerouslySetInnerHTML={{ __html: html }}
          />
        </pre>
      </div>
    );
  },
);

HighlightedBlock.displayName = "HighlightedBlock";

const CopyButton = ({ raw }: { raw: string }) => {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(raw);
      setCopied(true);
    } catch {
      // Clipboard permission denied: skip the ✓ flash; do not pop an error toast (chat code copy is not critical UX).
    }
  };
  return (
    <button
      type="button"
      onClick={onCopy}
      className="absolute right-1 top-1 inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      aria-label="Copy code"
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
    </button>
  );
};
