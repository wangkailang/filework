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

/** Ask App to open this file in the ContextDock (mirrors open-settings). */
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
      className="flex w-full items-center gap-2 px-3 py-1 text-left text-xs hover:bg-accent/40"
      title={file.path}
    >
      <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate text-foreground/80">
        {shortPath(file.path)}
      </span>
      {file.writeCount > 1 && (
        <span className="shrink-0 text-[10px] text-muted-foreground">
          ⟳ {file.writeCount}
        </span>
      )}
      <span className="ml-auto shrink-0 font-mono">
        {file.op === "delete" ? (
          <span className="text-red-400">已删除</span>
        ) : file.unknownStat ? (
          <span className="text-muted-foreground">已改动</span>
        ) : (
          <>
            <span className="text-emerald-500">+{file.added}</span>{" "}
            <span className="text-red-400">-{file.removed}</span>
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
        <span className="h-3.5 w-3.5 shrink-0 text-center text-muted-foreground">
          –
        </span>
      ) : ok ? (
        <Check className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
      ) : (
        <X className="h-3.5 w-3.5 shrink-0 text-red-400" />
      )}
      <span
        className="truncate font-mono text-foreground/80"
        title={cmd.command}
      >
        {cmd.command}
      </span>
      <span className="ml-auto shrink-0 font-mono text-[11px]">
        {cmd.testStats ? (
          <>
            <span className="text-emerald-500">
              {cmd.testStats.passed} 通过
            </span>
            {cmd.testStats.failed > 0 && (
              <span className="ml-1 text-red-400">
                {cmd.testStats.failed} 失败
              </span>
            )}
          </>
        ) : interrupted ? (
          <span className="text-muted-foreground">已中断</span>
        ) : ok ? (
          <span className="text-muted-foreground">exit 0</span>
        ) : (
          <span className="text-red-400">exit {cmd.exitCode}</span>
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
    <div className="my-1 overflow-hidden rounded-md border border-border bg-background/40">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs font-medium hover:bg-accent/30"
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
        )}
        <span className="text-foreground/80">本回合交付</span>
        <span className="text-muted-foreground">
          · {headerBits.join(" · ")}
        </span>
      </button>
      {expanded && (
        <div className="border-t border-border py-0.5">
          {files.map((f) => (
            <FileRow key={`${f.op}-${f.path}`} file={f} />
          ))}
          {files.length > 0 && commands.length > 0 && (
            <div className="my-0.5 border-t border-border/60" />
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
