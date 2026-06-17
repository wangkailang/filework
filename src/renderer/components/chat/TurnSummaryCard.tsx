import {
  Check,
  ChevronDown,
  ChevronRight,
  FilePlus,
  FileText,
  Trash2,
  X,
} from "lucide-react";
import { useState } from "react";

import type {
  TurnSummaryCommand,
  TurnSummaryFile,
  TurnSummaryPart,
} from "./types";

/** Last two path segments — enough to disambiguate without overflowing. */
function shortPath(p: string): string {
  const parts = p.split(/[/\\]/).filter(Boolean);
  return parts.length <= 2 ? p : `…/${parts.slice(-2).join("/")}`;
}

/** 请求 App 在 ContextDock 中打开此文件(与 open-settings 一致)。 */
function openFile(path: string) {
  window.dispatchEvent(
    new CustomEvent("filework:open-file", { detail: { path } }),
  );
}

function FileRow({ file }: { file: TurnSummaryFile }) {
  const Icon =
    file.op === "create" ? FilePlus : file.op === "delete" ? Trash2 : FileText;
  return (
    <button
      type="button"
      onClick={() => openFile(file.path)}
      className="group flex w-full cursor-pointer items-center gap-2 px-3 py-1 text-left text-xs transition-colors hover:bg-muted/25"
      title={file.path}
    >
      <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70 transition-colors group-hover:text-muted-foreground" />
      <span className="truncate text-foreground/65 underline decoration-transparent underline-offset-2 transition-colors group-hover:text-foreground/80 group-hover:decoration-muted-foreground/40">
        {shortPath(file.path)}
      </span>
      {file.writeCount > 1 && (
        <span className="shrink-0 text-[10px] text-muted-foreground">
          ⟳ {file.writeCount}
        </span>
      )}
      <span className="ml-auto shrink-0 font-mono">
        {file.op === "delete" ? (
          <span className="text-status-error/70">已删除</span>
        ) : file.unknownStat ? (
          <span className="text-muted-foreground/75">已改动</span>
        ) : (
          <>
            <span className="text-status-success/75">+{file.added}</span>{" "}
            <span className="text-status-error/70">-{file.removed}</span>
          </>
        )}
      </span>
    </button>
  );
}

function CommandRow({ cmd }: { cmd: TurnSummaryCommand }) {
  const ok = cmd.exitCode === 0;
  const interrupted = cmd.exitCode === null;
  return (
    <div className="flex items-center gap-2 px-3 py-1 text-xs">
      {interrupted ? (
        <span className="h-3.5 w-3.5 shrink-0 text-center text-muted-foreground/70">
          –
        </span>
      ) : ok ? (
        <Check className="h-3.5 w-3.5 shrink-0 text-status-success/70" />
      ) : (
        <X className="h-3.5 w-3.5 shrink-0 text-status-error/70" />
      )}
      <span
        className="truncate font-mono text-foreground/65"
        title={cmd.command}
      >
        {cmd.command}
      </span>
      <span className="ml-auto shrink-0 font-mono text-[11px]">
        {cmd.testStats ? (
          <>
            <span className="text-status-success/75">
              {cmd.testStats.passed} 通过
            </span>
            {cmd.testStats.failed > 0 && (
              <span className="ml-1 text-status-error/70">
                {cmd.testStats.failed} 失败
              </span>
            )}
          </>
        ) : interrupted ? (
          <span className="text-muted-foreground/75">已中断</span>
        ) : ok ? (
          <span className="text-muted-foreground/75">exit 0</span>
        ) : (
          <span className="text-status-error/70">exit {cmd.exitCode}</span>
        )}
      </span>
    </div>
  );
}

export function TurnSummaryCard({ part }: { part: TurnSummaryPart }) {
  const [expanded, setExpanded] = useState(false);
  const { files, commands } = part;
  const failedCmds = commands.filter(
    (c) => c.exitCode !== 0 && c.exitCode !== null,
  ).length;

  const headerBits: string[] = [];
  if (files.length > 0) headerBits.push(`${files.length} 文件`);
  if (commands.length > 0) {
    headerBits.push(
      failedCmds > 0
        ? `${commands.length} 命令(${failedCmds} 失败)`
        : `${commands.length} 命令`,
    );
  }

  return (
    <div className="my-1 overflow-hidden rounded-md border border-border/35 bg-muted/10">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs font-normal hover:bg-muted/25"
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground/65" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/65" />
        )}
        <span className="text-foreground/65">本回合交付</span>
        <span className="text-muted-foreground/75">
          · {headerBits.join(" · ")}
        </span>
      </button>
      {expanded && (
        <div className="border-t border-border/35 py-0.5">
          {files.map((f) => (
            <FileRow key={`${f.op}-${f.path}`} file={f} />
          ))}
          {files.length > 0 && commands.length > 0 && (
            <div className="my-0.5 border-t border-border/35" />
          )}
          {commands.map((c, i) => (
            <CommandRow
              // biome-ignore lint/suspicious/noArrayIndexKey: command list is append-only and never reordered; index is a stable identity
              key={`${i}-${c.command}`}
              cmd={c}
            />
          ))}
        </div>
      )}
    </div>
  );
}
