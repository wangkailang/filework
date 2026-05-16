import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import markdown from "highlight.js/lib/languages/markdown";
import php from "highlight.js/lib/languages/php";
import plaintext from "highlight.js/lib/languages/plaintext";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import scss from "highlight.js/lib/languages/scss";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
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
import { cn } from "../../lib/utils";

hljs.registerLanguage("bash", bash);
hljs.registerLanguage("c", c);
hljs.registerLanguage("cpp", cpp);
hljs.registerLanguage("csharp", csharp);
hljs.registerLanguage("css", css);
hljs.registerLanguage("diff", diff);
hljs.registerLanguage("dockerfile", dockerfile);
hljs.registerLanguage("go", go);
hljs.registerLanguage("ini", ini);
hljs.registerLanguage("java", java);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("kotlin", kotlin);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("php", php);
hljs.registerLanguage("plaintext", plaintext);
hljs.registerLanguage("python", python);
hljs.registerLanguage("ruby", ruby);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("scss", scss);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("swift", swift);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("yaml", yaml);

const LANG_ALIAS: Record<string, string> = {
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  tsx: "typescript",
  py: "python",
  rb: "ruby",
  rs: "rust",
  sh: "bash",
  zsh: "bash",
  shell: "bash",
  yml: "yaml",
  md: "markdown",
  kt: "kotlin",
  cs: "csharp",
  "c++": "cpp",
  "c#": "csharp",
  html: "xml",
  htm: "xml",
  svg: "xml",
  toml: "ini",
  conf: "ini",
  text: "plaintext",
  txt: "plaintext",
};

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

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

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
