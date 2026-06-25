import { FileText } from "lucide-react";
import type { ButtonHTMLAttributes, MouseEvent } from "react";
import { cn } from "../../lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../ui/tooltip";

const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const WINDOWS_ABSOLUTE_PATH = /^[A-Za-z]:[\\/]/;
const LINE_SUFFIX = /:(\d+)(?::\d+)?$/;

const FILE_EXTENSIONS = new Set([
  "bash",
  "c",
  "cjs",
  "cpp",
  "cs",
  "css",
  "csv",
  "env",
  "go",
  "graphql",
  "h",
  "hpp",
  "htm",
  "html",
  "java",
  "js",
  "json",
  "jsx",
  "kt",
  "less",
  "lock",
  "md",
  "mdx",
  "mjs",
  "php",
  "py",
  "rb",
  "rs",
  "sass",
  "scss",
  "sh",
  "sql",
  "svelte",
  "swift",
  "toml",
  "ts",
  "tsx",
  "txt",
  "vue",
  "xml",
  "yaml",
  "yml",
  "zsh",
]);

const WELL_KNOWN_FILENAMES = new Set([
  ".env",
  ".env.local",
  ".gitignore",
  "Dockerfile",
  "Makefile",
]);

export interface FilePathInfo {
  fullPath: string;
  label: string;
  line: string | null;
  title: string;
}

const trimTrailingSlash = (path: string): string => path.replace(/[\\/]+$/, "");

const isAbsolutePath = (path: string): boolean =>
  path.startsWith("/") || WINDOWS_ABSOLUTE_PATH.test(path);

const joinWorkspacePath = (workspacePath: string, relativePath: string) =>
  `${trimTrailingSlash(workspacePath)}/${relativePath.replace(/^\.?[\\/]/, "")}`;

const pathSegments = (path: string): string[] =>
  path.replace(/\\/g, "/").split("/").filter(Boolean);

const baseName = (path: string): string => {
  const segments = pathSegments(path);
  return segments.at(-1) ?? path;
};

const extensionOf = (name: string): string | null => {
  const dot = name.lastIndexOf(".");
  if (dot < 0 || dot === name.length - 1) return null;
  return name.slice(dot + 1).toLowerCase();
};

const hasRecognizedFileShape = (path: string): boolean => {
  const name = baseName(path);
  if (WELL_KNOWN_FILENAMES.has(name)) return true;
  const ext = extensionOf(name);
  return ext ? FILE_EXTENSIONS.has(ext) : false;
};

const relativeToWorkspace = (path: string, workspacePath?: string): string => {
  const root = workspacePath ? trimTrailingSlash(workspacePath) : "";
  if (root && path.startsWith(`${root}/`)) return path.slice(root.length + 1);
  return path;
};

export const getFilePathInfo = (
  raw: string | undefined,
  workspacePath?: string,
): FilePathInfo | null => {
  const text = raw?.trim() ?? "";
  if (!text || text.includes("\n") || URL_SCHEME.test(text)) return null;

  let path = text;
  let line: string | null = null;
  const lineMatch = LINE_SUFFIX.exec(text);
  if (lineMatch) {
    const withoutLine = text.slice(0, -lineMatch[0].length);
    if (hasRecognizedFileShape(withoutLine)) {
      path = withoutLine;
      line = lineMatch[1];
    }
  }

  if (!hasRecognizedFileShape(path)) return null;

  const absolute = isAbsolutePath(path);
  const hasPathSeparator = /[\\/]/.test(path);
  if (!absolute && !hasPathSeparator) return null;

  const fullPath = absolute
    ? path
    : workspacePath
      ? joinWorkspacePath(workspacePath, path)
      : path;
  const displayPath = relativeToWorkspace(path, workspacePath);
  const title = line ? `${fullPath}:${line}` : fullPath;

  return {
    fullPath,
    label: baseName(displayPath),
    line,
    title,
  };
};

export type FilePathChipProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  file: FilePathInfo;
};

export function FilePathChip({
  className,
  file,
  onClick,
  ...props
}: FilePathChipProps) {
  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    onClick?.(event);
    if (event.defaultPrevented) return;
    window.dispatchEvent(
      new window.CustomEvent("filework:open-file", {
        detail: { path: file.fullPath, line: file.line },
      }),
    );
  };

  const button = (
    <button
      {...props}
      aria-label={`Open ${file.title}`}
      className={cn(
        "inline-flex max-w-[min(12rem,100%)] cursor-pointer items-center gap-1 align-[-0.12em]",
        "rounded-[4px] px-1 py-0 font-mono text-[0.92em] leading-5 text-muted-foreground",
        "transition-[background-color,color,box-shadow] hover:bg-muted/65 hover:text-foreground",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/45",
        className,
      )}
      data-chat-file-path="true"
      data-file-full-path={file.fullPath}
      data-file-line={file.line ?? undefined}
      onClick={handleClick}
      title={file.title}
      type="button"
    >
      <FileText className="size-3.5 shrink-0 opacity-75" aria-hidden="true" />
      <span className="truncate">{file.label}</span>
    </button>
  );

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>{button}</TooltipTrigger>
        <TooltipContent
          className="max-w-[min(520px,calc(100vw-2rem))] break-all font-mono leading-snug"
          side="top"
          sideOffset={6}
        >
          {file.title}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
