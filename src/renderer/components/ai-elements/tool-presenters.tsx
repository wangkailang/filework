import { type Change, diffLines } from "diff";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type {
  PreviewDiffHunk,
  ToolPreview,
  WriteFilePreview,
} from "../../../main/core/agent/preview/types";
import type { ToolState } from "../../../main/core/session/message-parts";
import type { TranslationFunctions } from "../../i18n/i18n-types";
import { cn } from "../../lib/utils";
import { useLinkRouter } from "../browser/useLinkRouter";
import { DiffHunkView } from "./preview/DiffHunkView";

const MAX_OUTPUT_LINES = 30;
const MAX_LIST_ENTRIES = 50;
const MAX_COMMAND_SHORT = 60;

export interface PresenterCtx {
  LL: TranslationFunctions;
  workspacePath?: string;
  toolCallId: string;
  /** Snapshot captured by the approval batcher before the tool ran.
   *  Present writers prefer this over a fresh disk read. */
  previewSnapshot?: ToolPreview;
}

export interface ToolPresenter {
  summary?: (
    args: unknown,
    result: unknown,
    state: ToolState,
    ctx: PresenterCtx,
  ) => ReactNode | null;
  input?: (args: unknown, ctx: PresenterCtx) => ReactNode | null;
  output?: (
    result: unknown,
    args: unknown,
    state: ToolState,
    ctx: PresenterCtx,
  ) => ReactNode | null;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function shortPath(p: string, max = 48): string {
  if (!p || p.length <= max) return p;
  const parts = p.split("/");
  const last = parts[parts.length - 1] ?? p;
  if (last.length >= max - 1) return `…${last.slice(-(max - 1))}`;
  return `…/${last}`;
}

function countLines(s: string): number {
  if (!s) return 0;
  const n = s.split("\n").length;
  return s.endsWith("\n") ? n - 1 : n;
}

function truncateLines(
  s: string,
  max: number,
): { shown: string; remaining: number } {
  const lines = s.split("\n");
  if (lines.length <= max) return { shown: s, remaining: 0 };
  return {
    shown: lines.slice(0, max).join("\n"),
    remaining: lines.length - max,
  };
}

function resolvePath(p: string, workspacePath?: string): string {
  if (!p) return p;
  if (p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p)) return p;
  if (!workspacePath) return p;
  return `${workspacePath.replace(/\/$/, "")}/${p.replace(/^\.\//, "")}`;
}

// ---------------------------------------------------------------------------
// runCommand
// ---------------------------------------------------------------------------

const runCommandPresenter: ToolPresenter = {
  summary: (args, result, state, { LL }) => {
    const a = asRecord(args);
    const cmd = typeof a?.command === "string" ? a.command : "";
    const cmdShort =
      cmd.length > MAX_COMMAND_SHORT
        ? `${cmd.slice(0, MAX_COMMAND_SHORT)}…`
        : cmd;
    const r = asRecord(result);
    const shellId = typeof r?.shellId === "string" ? r.shellId : null;
    const shellStatus = typeof r?.status === "string" ? r.status : null;
    const exit =
      state === "output-available" && typeof r?.exitCode === "number"
        ? r.exitCode
        : null;
    return (
      <>
        <span className="text-foreground/80">$ {cmdShort}</span>
        {shellId && (
          <span className="ml-2 font-mono text-muted-foreground">
            {shellId}
          </span>
        )}
        {shellId && shellStatus === "running" && (
          <span className="ml-1 text-blue-400">⏵ running</span>
        )}
        {exit !== null && (
          <span
            className={cn(
              "ml-2",
              exit === 0 ? "text-muted-foreground" : "text-red-400",
            )}
          >
            {LL.tool_summary_exitCode(exit)}
          </span>
        )}
      </>
    );
  },
  input: (args) => {
    const a = asRecord(args);
    const cmd = typeof a?.command === "string" ? a.command : "";
    if (!cmd) return null;
    const bg = a?.runInBackground === true;
    return (
      <div className="px-3 py-2 border-b border-border">
        <pre className="text-xs font-mono whitespace-pre-wrap break-all">
          $ {cmd}
          {bg && (
            <span className="text-muted-foreground"> {"  "}(background)</span>
          )}
        </pre>
      </div>
    );
  },
  output: (result, _args, _state, { LL }) => {
    const r = asRecord(result);
    if (!r) return null;
    const stdout = typeof r.stdout === "string" ? r.stdout : "";
    const stderr = typeof r.stderr === "string" ? r.stderr : "";
    const exit = typeof r.exitCode === "number" ? r.exitCode : null;
    const shellId = typeof r.shellId === "string" ? r.shellId : null;
    const shellStatus = typeof r.status === "string" ? r.status : null;
    if (!stdout && !stderr && exit === null && !shellId) return null;
    return (
      <div className="px-3 py-2 text-xs space-y-2">
        {shellId && shellStatus === "running" && (
          <div className="text-[10px] uppercase tracking-wider text-blue-400">
            initial snapshot — use readShellOutput({shellId}) for more
          </div>
        )}
        {stdout ? (
          <CommandStream label={LL.tool_stdout()} body={stdout} LL={LL} />
        ) : null}
        {stderr ? (
          <CommandStream
            label={LL.tool_stderr()}
            body={stderr}
            LL={LL}
            tone="error"
          />
        ) : null}
        {exit !== null && (
          <div
            className={cn(
              "font-mono",
              exit === 0 ? "text-muted-foreground" : "text-red-400",
            )}
          >
            {LL.tool_summary_exitCode(exit)}
          </div>
        )}
      </div>
    );
  },
};

const readShellOutputPresenter: ToolPresenter = {
  summary: (args, result, state, { LL }) => {
    const a = asRecord(args);
    const r = asRecord(result);
    const shellId = typeof a?.shellId === "string" ? a.shellId : "";
    const status = typeof r?.status === "string" ? r.status : null;
    const stdoutLen =
      state === "output-available" && typeof r?.stdout === "string"
        ? r.stdout.length
        : 0;
    return (
      <>
        <span className="font-mono text-foreground/80">{shellId}</span>
        {status && (
          <span
            className={cn(
              "ml-2",
              status === "running" ? "text-blue-400" : "text-muted-foreground",
            )}
          >
            {status}
          </span>
        )}
        {stdoutLen > 0 && (
          <span className="ml-2 text-muted-foreground">
            +{stdoutLen} {LL.tool_stdout().toLowerCase()}
          </span>
        )}
      </>
    );
  },
  output: (result, _args, _state, { LL }) => {
    const r = asRecord(result);
    if (!r) return null;
    if (typeof r.error === "string") {
      return <div className="px-3 py-2 text-xs text-red-400">{r.error}</div>;
    }
    const stdout = typeof r.stdout === "string" ? r.stdout : "";
    const stderr = typeof r.stderr === "string" ? r.stderr : "";
    const truncated = r.truncated === true;
    if (!stdout && !stderr && !truncated) {
      return (
        <div className="px-3 py-2 text-xs text-muted-foreground italic">
          (no new output)
        </div>
      );
    }
    return (
      <div className="px-3 py-2 text-xs space-y-2">
        {truncated && (
          <div className="text-[10px] text-amber-400">
            buffer rolled — some intermediate output was dropped
          </div>
        )}
        {stdout ? (
          <CommandStream label={LL.tool_stdout()} body={stdout} LL={LL} />
        ) : null}
        {stderr ? (
          <CommandStream
            label={LL.tool_stderr()}
            body={stderr}
            LL={LL}
            tone="error"
          />
        ) : null}
      </div>
    );
  },
};

const killShellPresenter: ToolPresenter = {
  summary: (args, result) => {
    const a = asRecord(args);
    const r = asRecord(result);
    const shellId = typeof a?.shellId === "string" ? a.shellId : "";
    const found = r?.found === true;
    const killed = r?.killed === true;
    let label = "pending";
    if (r && !found) label = "not found";
    else if (r && killed) label = "killed";
    else if (r) label = "already exited";
    return (
      <>
        <span className="font-mono text-foreground/80">{shellId}</span>
        <span className="ml-2 text-muted-foreground">{label}</span>
      </>
    );
  },
};

function CommandStream({
  label,
  body,
  LL,
  tone,
}: {
  label: string;
  body: string;
  LL: TranslationFunctions;
  tone?: "error";
}) {
  const { shown, remaining } = truncateLines(body, MAX_OUTPUT_LINES);
  const link = useLinkRouter();
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
        {label}
      </div>
      <pre
        className={cn(
          "font-mono whitespace-pre-wrap break-all max-h-60 overflow-auto",
          tone === "error" && "text-red-400",
        )}
      >
        {renderWithLinks(shown, link)}
        {remaining > 0 && (
          <span className="block text-muted-foreground italic mt-1">
            {LL.tool_summary_more(remaining)}
          </span>
        )}
      </pre>
    </div>
  );
}

// Punctuation that almost always belongs to the surrounding prose
// (sentence enders, brackets, quotes), not the URL itself. `)` `]`
// `}` get bracket-balanced treatment below — they're only stripped
// when unmatched, so Wikipedia-style `Foo_(bar)` survives.
const URL_TRAILING_TEXT_PUNCT = /[.,;:!?'"]+$/;
const URL_REGEX = /(https?:\/\/[^\s<>"'`]+)/g;

/** If the URL ends with a closing bracket and the URL contains
 *  fewer opening than closing brackets, strip the trailing one
 *  (it was prose, not part of the URL). Repeats so e.g. `...))`
 *  unbalanced by 2 strips both. */
function stripUnbalancedBrackets(s: string): string {
  const PAIRS: Array<[string, string]> = [
    ["(", ")"],
    ["[", "]"],
    ["{", "}"],
  ];
  let out = s;
  let changed = true;
  while (changed) {
    changed = false;
    for (const [open, close] of PAIRS) {
      if (!out.endsWith(close)) continue;
      let opens = 0;
      let closes = 0;
      for (const ch of out) {
        if (ch === open) opens++;
        else if (ch === close) closes++;
      }
      if (closes > opens) {
        out = out.slice(0, -1);
        changed = true;
        break;
      }
    }
  }
  return out;
}

/** Split free-form text into a sequence of text + clickable link spans. */
function renderWithLinks(
  text: string,
  link: {
    onClick: (e: React.MouseEvent<HTMLAnchorElement>) => void;
    onAuxClick: (e: React.MouseEvent<HTMLAnchorElement>) => void;
  },
): ReactNode {
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let i = 0;
  for (const match of text.matchAll(URL_REGEX)) {
    const start = match.index ?? 0;
    if (start > lastIndex) nodes.push(text.slice(lastIndex, start));
    const raw = match[0];
    let href = raw;
    const textTail = href.match(URL_TRAILING_TEXT_PUNCT)?.[0] ?? "";
    if (textTail) href = href.slice(0, -textTail.length);
    href = stripUnbalancedBrackets(href);
    const trailing = raw.slice(href.length);
    nodes.push(
      <a
        key={`u-${i++}-${start}`}
        href={href}
        onClick={link.onClick}
        onAuxClick={link.onAuxClick}
        rel="noopener noreferrer"
        className="underline text-primary hover:opacity-80"
      >
        {href}
      </a>,
    );
    if (trailing) nodes.push(trailing);
    lastIndex = start + raw.length;
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes.length > 0 ? nodes : text;
}

// ---------------------------------------------------------------------------
// readFile
// ---------------------------------------------------------------------------

const readFilePresenter: ToolPresenter = {
  summary: (args, result, state, { LL }) => {
    const a = asRecord(args);
    const p = typeof a?.path === "string" ? a.path : "";
    const lines = typeof result === "string" ? countLines(result) : 0;
    return (
      <>
        <span className="text-foreground/80">{shortPath(p)}</span>
        {state === "output-available" && lines > 0 && (
          <span className="ml-2 text-muted-foreground">
            {LL.tool_summary_lines(lines)}
          </span>
        )}
      </>
    );
  },
  input: (args) => {
    const a = asRecord(args);
    const p = typeof a?.path === "string" ? a.path : "";
    if (!p) return null;
    return (
      <div className="px-3 py-2 border-b border-border">
        <pre className="text-xs font-mono text-muted-foreground break-all">
          {p}
        </pre>
      </div>
    );
  },
  output: (result, _args, _state, { LL }) => {
    if (typeof result !== "string") return null;
    return <FilePreview content={result} LL={LL} />;
  },
};

function FilePreview({
  content,
  LL,
}: {
  content: string;
  LL: TranslationFunctions;
}) {
  const [expanded, setExpanded] = useState(false);
  const { shown, remaining } = useMemo(
    () => truncateLines(content, MAX_OUTPUT_LINES),
    [content],
  );
  const body = expanded ? content : shown;
  return (
    <div className="px-3 py-2 text-xs">
      <pre className="font-mono whitespace-pre-wrap break-all max-h-80 overflow-auto">
        {body}
      </pre>
      {remaining > 0 && (
        <button
          type="button"
          onClick={() => setExpanded((s) => !s)}
          className="mt-1 text-xs text-blue-500 hover:underline"
        >
          {expanded
            ? LL.tool_hide_full()
            : `${LL.tool_show_full()} (${LL.tool_summary_more(remaining)})`}
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// listDirectory
// ---------------------------------------------------------------------------

interface DirEntry {
  name?: string;
  path?: string;
  isDirectory?: boolean;
}

function extractEntries(result: unknown): DirEntry[] {
  if (Array.isArray(result)) return result as DirEntry[];
  const r = asRecord(result);
  if (r && Array.isArray(r.files)) return r.files as DirEntry[];
  return [];
}

const listDirectoryPresenter: ToolPresenter = {
  summary: (args, result, state, { LL }) => {
    const a = asRecord(args);
    const p = typeof a?.path === "string" ? a.path : "";
    const entries = extractEntries(result);
    const dirs = entries.filter((e) => e?.isDirectory).length;
    const files = entries.length - dirs;
    return (
      <>
        <span className="text-foreground/80">{shortPath(p)}</span>
        {state === "output-available" && entries.length > 0 && (
          <span className="ml-2 text-muted-foreground">
            {LL.tool_summary_dirs_files(dirs, files)}
          </span>
        )}
      </>
    );
  },
  input: (args) => {
    const a = asRecord(args);
    const p = typeof a?.path === "string" ? a.path : "";
    if (!p) return null;
    return (
      <div className="px-3 py-2 border-b border-border">
        <pre className="text-xs font-mono text-muted-foreground break-all">
          {p}
        </pre>
      </div>
    );
  },
  output: (result, _args, _state, { LL }) => {
    const entries = extractEntries(result);
    if (!entries.length) return null;
    const shown = entries.slice(0, MAX_LIST_ENTRIES);
    const remaining = entries.length - shown.length;
    return (
      <div className="px-3 py-2 text-xs">
        <ul className="font-mono space-y-0.5 max-h-60 overflow-auto">
          {shown.map((e, i) => {
            const key = `${e?.path ?? e?.name ?? i}`;
            const label = e?.name ?? e?.path ?? "";
            return (
              <li
                key={key}
                className={cn("truncate", e?.isDirectory && "text-blue-500")}
              >
                {e?.isDirectory ? "📁 " : "📄 "}
                {label}
              </li>
            );
          })}
        </ul>
        {remaining > 0 && (
          <div className="mt-1 text-muted-foreground italic">
            {LL.tool_summary_more(remaining)}
          </div>
        )}
      </div>
    );
  },
};

// ---------------------------------------------------------------------------
// writeFile (with unified diff)
//
// Diff requires the file's **pre-image** content. We must read it BEFORE the
// write executes — once state hits "output-available" the file on disk is
// already the new content, and a fresh read would show +0/-0.
//
// Strategy: every render of the writeFile summary (mounted from input-
// streaming onwards) triggers a one-shot read; we then **compute the diff
// once** and cache only the resulting Change[] + stats, keyed by toolCallId.
// If we ever observe the tool starting at "output-available" (e.g. session
// reload), we mark it as cold-start and skip diff entirely.
// ---------------------------------------------------------------------------

interface WriteDiffPayload {
  added: number;
  removed: number;
  changes: Change[];
  isNew: boolean;
}

const WRITE_CACHE_MAX = 32;
const writeDiffCache = new Map<string, WriteDiffPayload>();
const writeColdStart = new Set<string>();
const writeInFlight = new Map<string, Promise<void>>();

function computeDiff(
  oldText: string | null,
  newText: string,
): WriteDiffPayload {
  if (oldText === null) {
    const lines = countLines(newText);
    return {
      added: lines,
      removed: 0,
      changes: [{ value: newText, added: true, removed: false, count: lines }],
      isNew: true,
    };
  }
  const changes = diffLines(oldText, newText);
  let added = 0;
  let removed = 0;
  for (const c of changes) {
    const lines = c.count ?? countLines(c.value);
    if (c.added) added += lines;
    else if (c.removed) removed += lines;
  }
  return { added, removed, changes, isNew: false };
}

function setWriteCache(toolCallId: string, payload: WriteDiffPayload) {
  if (
    writeDiffCache.size >= WRITE_CACHE_MAX &&
    !writeDiffCache.has(toolCallId)
  ) {
    const oldest = writeDiffCache.keys().next().value;
    if (oldest !== undefined) writeDiffCache.delete(oldest);
  }
  writeDiffCache.set(toolCallId, payload);
}

function captureWriteDiff(
  toolCallId: string,
  path: string,
  workspacePath: string | undefined,
  state: ToolState,
  newContent: string,
): Promise<void> {
  if (writeDiffCache.has(toolCallId) || writeColdStart.has(toolCallId)) {
    return writeInFlight.get(toolCallId) ?? Promise.resolve();
  }
  if (state === "output-available") {
    writeColdStart.add(toolCallId);
    return Promise.resolve();
  }
  if (!path) {
    setWriteCache(toolCallId, computeDiff(null, newContent));
    return Promise.resolve();
  }
  let p = writeInFlight.get(toolCallId);
  if (!p) {
    const abs = resolvePath(path, workspacePath);
    p = window.filework
      .readFile(abs)
      .then((c) => {
        const oldText = typeof c === "string" ? c : null;
        setWriteCache(toolCallId, computeDiff(oldText, newContent));
      })
      .catch(() => {
        setWriteCache(toolCallId, computeDiff(null, newContent));
      })
      .finally(() => {
        writeInFlight.delete(toolCallId);
      });
    writeInFlight.set(toolCallId, p);
  }
  return p;
}

interface WriteDiffSnap {
  cold: boolean;
  ready: boolean;
  payload: WriteDiffPayload | null;
}

function readWriteDiffSnap(toolCallId: string): WriteDiffSnap {
  return {
    cold: writeColdStart.has(toolCallId),
    ready: writeDiffCache.has(toolCallId),
    payload: writeDiffCache.get(toolCallId) ?? null,
  };
}

function snapshotToPayload(snapshot: WriteFilePreview): WriteDiffPayload {
  const changes: Change[] = snapshot.hunks.map((h) => ({
    value: h.value,
    added: h.kind === "added",
    removed: h.kind === "removed",
    count: h.lineCount,
  }));
  return {
    added: snapshot.added,
    removed: snapshot.removed,
    changes,
    isNew: snapshot.action === "create",
  };
}

function useWriteDiff(
  toolCallId: string,
  path: string,
  workspacePath: string | undefined,
  state: ToolState,
  newContent: string,
  snapshot: ToolPreview | undefined,
): WriteDiffSnap {
  const [, setTick] = useState(0);
  const firedRef = useRef(false);

  const writeSnapshot =
    snapshot && snapshot.kind === "write" ? snapshot : undefined;

  useEffect(() => {
    if (writeSnapshot) {
      // Hydrate the cache so summary/diff consumers see a `ready` snap
      // even though we never read from disk.
      if (!writeDiffCache.has(toolCallId)) {
        setWriteCache(toolCallId, snapshotToPayload(writeSnapshot));
      }
      return;
    }
    let active = true;
    captureWriteDiff(toolCallId, path, workspacePath, state, newContent).then(
      () => {
        if (active && !firedRef.current) {
          firedRef.current = true;
          setTick((t) => t + 1);
        }
      },
    );
    return () => {
      active = false;
    };
  }, [toolCallId, path, workspacePath, state, newContent, writeSnapshot]);
  return readWriteDiffSnap(toolCallId);
}

const writeFilePresenter: ToolPresenter = {
  summary: (
    args,
    _result,
    state,
    { LL, workspacePath, toolCallId, previewSnapshot },
  ) => {
    const a = asRecord(args);
    const p = typeof a?.path === "string" ? a.path : "";
    return (
      <>
        <span className="text-foreground/80">{shortPath(p)}</span>
        <WriteSummary
          args={args}
          state={state}
          LL={LL}
          workspacePath={workspacePath}
          toolCallId={toolCallId}
          previewSnapshot={previewSnapshot}
        />
      </>
    );
  },
  input: (args) => {
    const a = asRecord(args);
    const p = typeof a?.path === "string" ? a.path : "";
    if (!p) return null;
    return (
      <div className="px-3 py-2 border-b border-border">
        <pre className="text-xs font-mono text-muted-foreground break-all">
          {p}
        </pre>
      </div>
    );
  },
  output: (
    _result,
    args,
    state,
    { LL, workspacePath, toolCallId, previewSnapshot },
  ) => (
    <WriteDiff
      args={args}
      state={state}
      LL={LL}
      workspacePath={workspacePath}
      toolCallId={toolCallId}
      previewSnapshot={previewSnapshot}
    />
  ),
};

function readWriteArgs(args: unknown): { path: string; content: string } {
  const a = asRecord(args);
  return {
    path: typeof a?.path === "string" ? a.path : "",
    content: typeof a?.content === "string" ? a.content : "",
  };
}

function WriteSummary({
  args,
  state,
  LL,
  workspacePath,
  toolCallId,
  previewSnapshot,
}: {
  args: unknown;
  state: ToolState;
  LL: TranslationFunctions;
  workspacePath?: string;
  toolCallId: string;
  previewSnapshot?: ToolPreview;
}) {
  const { path, content } = readWriteArgs(args);
  const { cold, ready, payload } = useWriteDiff(
    toolCallId,
    path,
    workspacePath,
    state,
    content,
    previewSnapshot,
  );
  if (state !== "output-available") return null;
  if (cold) {
    return (
      <span className="ml-2 text-muted-foreground font-mono">
        {LL.tool_summary_lines(countLines(content))}
      </span>
    );
  }
  if (!ready || !payload) return null;
  if (payload.isNew) {
    return (
      <span className="ml-2 text-emerald-500 font-mono">
        {LL.tool_summary_new_file()} · {LL.tool_summary_lines(payload.added)}
      </span>
    );
  }
  return (
    <span className="ml-2 font-mono">
      <span className="text-emerald-500">+{payload.added}</span>{" "}
      <span className="text-red-400">-{payload.removed}</span>
    </span>
  );
}

function WriteDiff({
  args,
  state,
  LL,
  workspacePath,
  toolCallId,
  previewSnapshot,
}: {
  args: unknown;
  state: ToolState;
  LL: TranslationFunctions;
  workspacePath?: string;
  toolCallId: string;
  previewSnapshot?: ToolPreview;
}) {
  const { path, content } = readWriteArgs(args);
  const { cold, ready, payload } = useWriteDiff(
    toolCallId,
    path,
    workspacePath,
    state,
    content,
    previewSnapshot,
  );
  if (!cold && !ready) {
    return (
      <div className="px-3 py-2 text-xs text-muted-foreground italic">…</div>
    );
  }
  if (cold) {
    return (
      <div className="px-3 py-2 text-xs">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
          {LL.tool_summary_lines(countLines(content))}
        </div>
        <pre className="font-mono whitespace-pre-wrap break-all rounded border border-border bg-background/40 p-2">
          {content}
        </pre>
      </div>
    );
  }
  const isNew = payload?.isNew ?? false;
  const changes: Change[] = payload?.changes ?? [];
  return (
    <div className="px-3 py-2 text-xs">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
        {LL.tool_diff_label()}
        {isNew && (
          <span className="ml-2 text-emerald-500 normal-case tracking-normal">
            {LL.tool_summary_new_file()}
          </span>
        )}
      </div>
      <div className="font-mono whitespace-pre-wrap break-all rounded border border-border bg-background/40">
        {changes.map((c, i) => (
          <DiffHunkView
            // biome-ignore lint/suspicious/noArrayIndexKey: diff hunks have no stable id; position is the identity
            key={`${i}-${c.value.slice(0, 8)}`}
            hunk={changeToPreviewHunk(c)}
            collapseContext={!isNew}
          />
        ))}
      </div>
    </div>
  );
}

function changeToPreviewHunk(c: Change): PreviewDiffHunk {
  const kind: PreviewDiffHunk["kind"] = c.added
    ? "added"
    : c.removed
      ? "removed"
      : "context";
  return {
    kind,
    value: c.value,
    lineCount: c.count ?? countLines(c.value),
  };
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const toolPresenters: Record<string, ToolPresenter> = {
  runCommand: runCommandPresenter,
  readFile: readFilePresenter,
  listDirectory: listDirectoryPresenter,
  writeFile: writeFilePresenter,
  readShellOutput: readShellOutputPresenter,
  killShell: killShellPresenter,
};
