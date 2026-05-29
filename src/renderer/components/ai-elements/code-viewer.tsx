import { useEffect, useRef, useState } from "react";
import { useI18nContext } from "../../i18n/i18n-react";
import { highlightToLines, resolveHljsLang } from "../../lib/highlight";
import { cn } from "../../lib/utils";

/** 可按文本预览的扩展名集合;不在此列的由上层走"不支持"分支。 */
export const SUPPORTED_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".html",
  ".css",
  ".scss",
  ".less",
  ".json",
  ".yaml",
  ".yml",
  ".toml",
  ".xml",
  ".csv",
  ".md",
  ".txt",
  ".log",
  ".py",
  ".sh",
  ".bash",
  ".zsh",
  ".env",
  ".gitignore",
  ".editorconfig",
  ".sql",
  ".graphql",
  ".prisma",
]);

/** 取文件扩展名(含点),正确处理 .env / .gitignore 这类 dotfile。 */
export const getFileExtension = (filename: string): string => {
  const base = filename.split("/").pop() || filename;
  // dotfile(如 .env、.gitignore):整名即扩展名
  if (base.startsWith(".") && !base.includes(".", 1)) {
    return base;
  }
  const dotIndex = base.lastIndexOf(".");
  return dotIndex > 0 ? base.slice(dotIndex) : "";
};

export const isSupportedFile = (filename: string): boolean => {
  return SUPPORTED_EXTENSIONS.has(getFileExtension(filename));
};

// —— 高亮降级阈值(对齐 Codex CLI / VS Code 的工程实践)——
// 超过任一阈值则放弃语法高亮、退回纯文本(仍做虚拟化渲染)。
// 依据:Codex CLI 对 >512KB 或 >1 万行的输入直接跳过高亮;
//       VS Code 单行 token 上限(maxTokenizationLineLength)约 2 万字符。
const HIGHLIGHT_MAX_CHARS = 512 * 1024;
const HIGHLIGHT_MAX_LINES = 10_000;
const HIGHLIGHT_MAX_LINE_LENGTH = 20_000;

// 虚拟化参数:等宽字体行高固定,只渲染可视窗口 + 上下各 OVERSCAN 行缓冲。
const LINE_HEIGHT = 20; // px,需与下方行的内联样式保持一致
const OVERSCAN = 20;

interface CodeViewerProps {
  code: string;
  filename: string;
  className?: string;
}

interface PreparedLines {
  /** 每项为一行内容:highlighted 时是 HTML 片段,否则是纯文本。 */
  lines: string[];
  highlighted: boolean;
}

/**
 * 把整段文本切成"逐行"结构供虚拟化渲染:体量在阈值内则用 hljs 整段高亮后按行切分,
 * 否则退回纯文本逐行。高亮一次性完成,避免按窗口高亮带来的跨行语法上下文丢失。
 */
const prepareLines = (code: string, filename: string): PreparedLines => {
  const rawLines = code.split("\n");
  const lang = resolveHljsLang(getFileExtension(filename));
  const canHighlight =
    lang !== null &&
    code.length <= HIGHLIGHT_MAX_CHARS &&
    rawLines.length <= HIGHLIGHT_MAX_LINES &&
    rawLines.every((line) => line.length <= HIGHLIGHT_MAX_LINE_LENGTH);

  return canHighlight
    ? { lines: highlightToLines(code, lang), highlighted: true }
    : { lines: rawLines, highlighted: false };
};

export const CodeViewer = ({ code, filename, className }: CodeViewerProps) => {
  const { LL } = useI18nContext();
  const [prepared, setPrepared] = useState<PreparedLines | null>(null);

  useEffect(() => {
    let cancelled = false;
    setPrepared(null);
    // 让出一帧再算:大文件高亮/切行可能耗时,先让 loading 态出来,避免阻塞首帧。
    const id = setTimeout(() => {
      if (!cancelled) setPrepared(prepareLines(code, filename));
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
  }, [code, filename]);

  if (!prepared) {
    return (
      <div
        className={cn(
          "flex items-center justify-center p-8 text-muted-foreground text-sm",
          className,
        )}
      >
        {LL.code_loading()}
      </div>
    );
  }

  return (
    <VirtualizedCode
      lines={prepared.lines}
      highlighted={prepared.highlighted}
      className={className}
    />
  );
};

/**
 * 定高窗口化的代码渲染:任何文件大小都只把可视区(+缓冲)的行放进 DOM,
 * 上下用占位 div 撑出滚动条总高度。这是大文件不卡的关键。
 */
const VirtualizedCode = ({
  lines,
  highlighted,
  className,
}: PreparedLines & { className?: string }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    setViewportHeight(el.clientHeight);
    const observer = new ResizeObserver(() =>
      setViewportHeight(el.clientHeight),
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const total = lines.length;
  const start = Math.max(0, Math.floor(scrollTop / LINE_HEIGHT) - OVERSCAN);
  const end = Math.min(
    total,
    Math.ceil((scrollTop + viewportHeight) / LINE_HEIGHT) + OVERSCAN,
  );
  const visible = lines.slice(start, end);

  return (
    <div
      ref={containerRef}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      className={cn(
        "overflow-auto whitespace-pre font-mono text-sm hljs",
        className,
      )}
    >
      {/* 顶部占位:撑出未渲染行的高度 */}
      <div style={{ height: start * LINE_HEIGHT }} />
      {visible.map((line, i) => {
        const lineNo = start + i;
        const style = { height: LINE_HEIGHT, lineHeight: `${LINE_HEIGHT}px` };
        return highlighted ? (
          <div
            key={lineNo}
            className="px-4"
            style={style}
            // biome-ignore lint/security/noDangerouslySetInnerHtml: 内容由 hljs 从本地文件生成,标签为转义后的 token 标记。
            dangerouslySetInnerHTML={{ __html: line }}
          />
        ) : (
          <div key={lineNo} className="px-4" style={style}>
            {line}
          </div>
        );
      })}
      {/* 底部占位 */}
      <div style={{ height: (total - end) * LINE_HEIGHT }} />
    </div>
  );
};
