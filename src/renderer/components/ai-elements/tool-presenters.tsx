import { type Change, diffLines } from "diff";
import { type ReactNode, useEffect, useRef, useState } from "react";
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
const MAX_WEB_CONTENT_CHARS = 7000;
const TOOL_SUMMARY_TEXT = "text-foreground/65";
const TOOL_MUTED_TEXT = "text-muted-foreground/75";
const TOOL_SUCCESS_TEXT = "text-status-success/75";
const TOOL_ERROR_TEXT = "text-status-error/70";

export interface PresenterCtx {
  LL: TranslationFunctions;
  workspacePath?: string;
  toolCallId: string;
  /** 审批批处理器在工具运行前捕获的快照。
   *  写入展示器优先使用它,而非重新从磁盘读取。 */
  previewSnapshot?: ToolPreview;
}

export interface ToolPresenter {
  summary?: (
    args: unknown,
    result: unknown,
    state: ToolState,
    ctx: PresenterCtx,
  ) => ReactNode | null;
  /**
   * 为一组连续同名调用(例如连续 5 次 webSearch)折叠后的单行摘要。
   * 接收每次调用的 args,从而可以列出变化的内容(查询词),而不是单纯的
   * "5 个 webSearch"。缺省时回退到通用的计数标签。
   */
  groupSummary?: (argsList: unknown[], ctx: PresenterCtx) => ReactNode | null;
  /** 该行是否有值得展开的内嵌内容。返回 false 时渲染为静态行(无 chevron)。
   *  缺省视为可展开(维持既有行为)。 */
  expandable?: (
    args: unknown,
    result: unknown,
    state: ToolState,
    ctx: PresenterCtx,
  ) => boolean;
  /** 行尾常驻动作(hover 显现),挂在折叠触发器之外 —— 无需展开即可直达。 */
  rowAction?: (args: unknown, ctx: PresenterCtx) => ReactNode | null;
  input?: (args: unknown, ctx: PresenterCtx) => ReactNode | null;
  output?: (
    result: unknown,
    args: unknown,
    state: ToolState,
    ctx: PresenterCtx,
  ) => ReactNode | null;
}

// ---------------------------------------------------------------------------
// 共享辅助函数
// ---------------------------------------------------------------------------

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/** 展示用路径:尽量展示完整路径。优先折成工作区相对路径(src/js/x.js),
 *  否则原样保留。横向溢出交给 CSS truncate,完整绝对路径由调用处挂 title。 */
function displayPath(p: string, workspacePath?: string): string {
  if (!p) return p;
  const root = workspacePath?.replace(/\/$/, "");
  if (root && p.startsWith(`${root}/`)) return p.slice(root.length + 1);
  return p;
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
        <span className={TOOL_SUMMARY_TEXT}>$ {cmdShort}</span>
        {shellId && (
          <span className={cn("ml-2 font-mono", TOOL_MUTED_TEXT)}>
            {shellId}
          </span>
        )}
        {shellId && shellStatus === "running" && (
          <span className="ml-1 text-status-running/70">⏵ running</span>
        )}
        {exit !== null && (
          <span
            className={cn(
              "ml-2",
              exit === 0 ? TOOL_MUTED_TEXT : TOOL_ERROR_TEXT,
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
      <div className="px-3 py-2 border-b border-border/35">
        <pre className="text-xs font-mono text-muted-foreground/95 whitespace-pre-wrap break-all">
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
    const hint = typeof r.displayHint === "string" ? r.displayHint : "";
    if (!stdout && !stderr && exit === null && !shellId && !hint) return null;
    return (
      <div className="px-3 py-2 text-xs space-y-2">
        {shellId && shellStatus === "running" && (
          <div className="text-[10px] uppercase tracking-wider text-status-running/70">
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
        {hint ? (
          <div
            data-command-hint="true"
            className="rounded-md border border-border/60 bg-muted/30 px-2 py-1.5 text-[11px] leading-relaxed text-muted-foreground"
          >
            {hint}
          </div>
        ) : null}
        {exit !== null && (
          <div
            className={cn(
              "font-mono",
              exit === 0 ? TOOL_MUTED_TEXT : TOOL_ERROR_TEXT,
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
        <span className={cn("font-mono", TOOL_SUMMARY_TEXT)}>{shellId}</span>
        {status && (
          <span
            className={cn(
              "ml-2",
              status === "running" ? "text-status-running/70" : TOOL_MUTED_TEXT,
            )}
          >
            {status}
          </span>
        )}
        {stdoutLen > 0 && (
          <span className={cn("ml-2", TOOL_MUTED_TEXT)}>
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
      return (
        <div className="px-3 py-2 text-xs text-status-error/80">{r.error}</div>
      );
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
          <div className="text-[10px] text-status-await/75">
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
        <span className={cn("font-mono", TOOL_SUMMARY_TEXT)}>{shellId}</span>
        <span className={cn("ml-2", TOOL_MUTED_TEXT)}>{label}</span>
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
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground/65 mb-1">
        {label}
      </div>
      <pre
        className={cn(
          "font-mono text-muted-foreground/95 whitespace-pre-wrap break-all max-h-60 overflow-auto",
          tone === "error" && "text-status-error/80",
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

// 几乎总是属于周围文本(句末标点、括号、引号)而非 URL 本身的标点。
// `)` `]` `}` 在下方采用括号配平处理 —— 只有在不匹配时才被剥除,
// 因此 Wikipedia 风格的 `Foo_(bar)` 得以保留。
const URL_TRAILING_TEXT_PUNCT = /[.,;:!?'"]+$/;
const URL_REGEX = /(https?:\/\/[^\s<>"'`]+)/g;

/** 如果 URL 以闭合括号结尾,且其中开括号数量少于闭括号数量,
 *  则剥除末尾这个括号(它属于文本,而非 URL 的一部分)。会重复执行,
 *  例如失衡 2 个的 `...))` 会被全部剥除。 */
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

/** 将自由格式文本拆分为一系列文本片段与可点击链接片段。 */
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
        className="underline text-primary/80 hover:text-primary"
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
  summary: (args, result, state, { LL, workspacePath }) => {
    const a = asRecord(args);
    const p = typeof a?.path === "string" ? a.path : "";
    const lines = typeof result === "string" ? countLines(result) : 0;
    return (
      <>
        <span className={TOOL_SUMMARY_TEXT} title={p}>
          {displayPath(p, workspacePath)}
        </span>
        {state === "output-available" && lines > 0 && (
          <span className={cn("ml-2", TOOL_MUTED_TEXT)}>
            {LL.tool_summary_lines(lines)}
          </span>
        )}
      </>
    );
  },
  // 展开展示"当时读到的内容"(result 随消息持久化)。默认折叠、有界滚动 ——
  // 既不在对话流默认态铺成墙,又保证看到的是该次读取的快照,而非磁盘上可能
  // 已被后续改动的活文件。
  expandable: (_args, result) =>
    typeof result === "string" && result.length > 0,
  output: (result) => {
    if (typeof result !== "string" || !result) return null;
    return (
      <div className="px-3 py-2 text-xs">
        <pre className="max-h-80 overflow-auto font-mono text-muted-foreground/95 whitespace-pre-wrap break-all">
          {result}
        </pre>
      </div>
    );
  },
};

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
  summary: (args, result, state, { LL, workspacePath }) => {
    const a = asRecord(args);
    const p = typeof a?.path === "string" ? a.path : "";
    const entries = extractEntries(result);
    const dirs = entries.filter((e) => e?.isDirectory).length;
    const files = entries.length - dirs;
    return (
      <>
        <span className={TOOL_SUMMARY_TEXT} title={p}>
          {displayPath(p, workspacePath)}
        </span>
        {state === "output-available" && entries.length > 0 && (
          <span className={cn("ml-2", TOOL_MUTED_TEXT)}>
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
      <div className="px-3 py-2 border-b border-border/35">
        <pre className="text-xs font-mono text-muted-foreground/85 break-all">
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
                className={cn(
                  "truncate",
                  e?.isDirectory && "text-muted-foreground/85",
                )}
              >
                {e?.isDirectory ? "📁 " : "📄 "}
                {label}
              </li>
            );
          })}
        </ul>
        {remaining > 0 && (
          <div className="mt-1 text-muted-foreground/75 italic">
            {LL.tool_summary_more(remaining)}
          </div>
        )}
      </div>
    );
  },
};

// ---------------------------------------------------------------------------
// writeFile(含统一 diff)
//
// diff 需要文件的**前镜像**内容。我们必须在写入执行之前读取它 —— 一旦状态
// 变为 "output-available",磁盘上的文件已是新内容,重新读取只会显示 +0/-0。
//
// 策略:writeFile 摘要的每次渲染(自 input-streaming 起挂载)都会触发一次性
// 读取;随后我们**只计算一次 diff**,并仅缓存得到的 Change[] 与统计数据,
// 以 toolCallId 为键。若观察到工具一开始就处于 "output-available"(例如会话
// 重载),则将其标记为冷启动并完全跳过 diff。
// ---------------------------------------------------------------------------

interface WriteDiffPayload {
  added: number;
  removed: number;
  hunks: PreviewDiffHunk[];
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
      hunks: [{ kind: "added", value: newText, lineCount: lines, newStart: 1 }],
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
  return {
    added,
    removed,
    hunks: changesToPreviewHunks(changes),
    isNew: false,
  };
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
  return {
    added: snapshot.added,
    removed: snapshot.removed,
    hunks: snapshot.hunks,
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
      // 填充缓存,使 summary/diff 的消费方即便从未从磁盘读取也能看到
      // 一个 `ready` 的快照。
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
    result,
    state,
    { workspacePath, toolCallId, previewSnapshot },
  ) => {
    const a = asRecord(args);
    const p = typeof a?.path === "string" ? a.path : "";
    return (
      <>
        <span className={TOOL_SUMMARY_TEXT} title={p}>
          {displayPath(p, workspacePath)}
        </span>
        <WriteSummary
          args={args}
          result={result}
          state={state}
          workspacePath={workspacePath}
          toolCallId={toolCallId}
          previewSnapshot={previewSnapshot}
        />
      </>
    );
  },
  // 展开看变更:有快照时显示 diff(编辑=+/-,新文件=全增);重载会话丢了
  // 进程本地快照(见 jsonl-store)算不出 diff,则回退展示写入的内容本身
  // (args.content 随消息持久化)。两种都默认折叠、有界滚动,且恒等于该次
  // 写入的快照,而非磁盘上可能已被后续改动的活文件。
  expandable: (args, _result, _state, { previewSnapshot: s }) => {
    if (s && s.kind === "write" && s.added + s.removed > 0) return true;
    return readWriteArgs(args).content.length > 0;
  },
  output: (
    result,
    args,
    state,
    { LL, workspacePath, toolCallId, previewSnapshot },
  ) => (
    <WriteDiff
      args={args}
      result={result}
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

/** writeFile 工具在执行前对前镜像算好的权威 diff(随结果持久化,见
 *  tools/index.ts)。是 isNew / +N -M / 逐行 hunks 的事实来源 —— 不靠快照、
 *  也不靠渲染端凭 content 猜,且跨重载会话依然可用。 */
function readWriteStat(result: unknown): {
  added: number;
  removed: number;
  isNew: boolean;
  hunks: PreviewDiffHunk[];
} | null {
  const d = asRecord(asRecord(result)?.diffStat);
  if (!d) return null;
  return {
    added: typeof d.added === "number" ? d.added : 0,
    removed: typeof d.removed === "number" ? d.removed : 0,
    isNew: d.isNew === true,
    hunks: Array.isArray(d.hunks) ? (d.hunks as PreviewDiffHunk[]) : [],
  };
}

function WriteSummary({
  args,
  result,
  state,
  workspacePath,
  toolCallId,
  previewSnapshot,
}: {
  args: unknown;
  result: unknown;
  state: ToolState;
  workspacePath?: string;
  toolCallId: string;
  previewSnapshot?: ToolPreview;
}) {
  const { path, content } = readWriteArgs(args);
  // 仍调用以预热共享 diff 缓存(供展开的 body 用),但统计数字以权威 diffStat 为准。
  const { payload } = useWriteDiff(
    toolCallId,
    path,
    workspacePath,
    state,
    content,
    previewSnapshot,
  );
  if (state !== "output-available") return null;
  // +N -M 直接放外层这一行。优先用工具权威 diffStat(执行前对前镜像算好、
  // 已持久化),其次快照;都没有再等异步算出 —— 绝不靠 content 凭空当全增。
  const stat = readWriteStat(result);
  const added = stat?.added ?? payload?.added;
  const removed = stat?.removed ?? payload?.removed;
  if (added == null || removed == null) return null;
  return (
    <span className="ml-2 font-mono">
      <span className={TOOL_SUCCESS_TEXT}>+{added}</span>{" "}
      <span className={TOOL_ERROR_TEXT}>-{removed}</span>
    </span>
  );
}

function WriteDiff({
  args,
  result,
  state,
  LL,
  workspacePath,
  toolCallId,
  previewSnapshot,
}: {
  args: unknown;
  result: unknown;
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
  const stat = readWriteStat(result);
  // 异步算 diff 尚未就绪(有前镜像可比对的编辑场景):等一拍。
  if (!stat && !cold && !ready) {
    return (
      <div className="px-3 py-2 text-xs text-muted-foreground/75 italic">…</div>
    );
  }
  // isNew 以工具权威 diffStat 为准(执行前对前镜像算好),其次快照 —— 绝不靠
  // content 凭空判定。这样覆盖已存在文件不会被误标"新建文件"。
  const isNew = stat?.isNew ?? payload?.isNew ?? false;
  // 逐行 hunks 来源优先级:
  //   1) 持久化的 result.diffStat.hunks —— 最稳,跨重载会话依然可用;
  //   2) 进程内快照 / 异步算出的 diff;
  //   3) 仅新文件可用持久化 content 合成"全增"(语义正确)。
  // 都没有(如编辑但旧镜像不可得)→ 老实展示写入内容,不伪造。
  const hunks: PreviewDiffHunk[] | null = stat?.hunks?.length
    ? stat.hunks
    : payload
      ? payload.hunks
      : isNew
        ? computeDiff(null, content).hunks
        : null;
  const statOnlyHunks =
    !hunks && stat && (stat.added > 0 || stat.removed > 0)
      ? buildStatOnlyHunks(stat, LL)
      : null;
  const displayedHunks = hunks ?? statOnlyHunks;
  return (
    <div
      data-write-file-diff="true"
      className="overflow-hidden bg-surface-sunken text-xs"
    >
      {/* +N -M 已在外层头部那行展示;body 直接放 hunks,不再额外加"差异"标题。 */}
      {isNew && (
        <div
          className={cn(
            "border-border-faint border-b px-3 py-1.5 text-[10px] tracking-normal",
            TOOL_SUCCESS_TEXT,
          )}
        >
          {LL.tool_summary_new_file()}
        </div>
      )}
      {statOnlyHunks && (
        <div className="border-border-faint border-b px-3 py-1.5 text-[11px] text-muted-foreground/75">
          {LL.preview_diff_details_unavailable()}
        </div>
      )}
      {displayedHunks ? (
        <div
          data-write-file-diff-code="true"
          className="max-h-72 overflow-auto bg-surface-sunken font-mono text-[11px] leading-5"
        >
          <div className="min-w-full">
            {displayedHunks.map((h, i) => (
              <DiffHunkView
                // biome-ignore lint/suspicious/noArrayIndexKey: diff hunks have no stable id; position is the identity
                key={`${i}-${h.value.slice(0, 8)}`}
                hunk={h}
                collapseContext={!isNew}
                density="branch"
              />
            ))}
          </div>
        </div>
      ) : (
        // 编辑 + 无任何 diff 来源:老实展示该次写入的内容本身,不谎称新建、
        // 不伪造全增。完整 +/- 统计在头部那行。
        <div
          data-write-file-diff-code="true"
          className="max-h-72 overflow-auto bg-surface-sunken font-mono text-[11px] leading-5 opacity-75"
        >
          <DiffHunkView
            collapseContext={false}
            density="branch"
            hunk={{
              kind: "context",
              value: content,
              lineCount: countLines(content),
            }}
          />
        </div>
      )}
      {statOnlyHunks && content.length > 0 && (
        <div className="border-border-faint border-t">
          <div className="border-border-faint border-b px-3 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground/65">
            {LL.preview_written_snapshot_label()}
          </div>
          <pre
            data-written-snapshot="true"
            className="max-h-48 overflow-auto bg-surface-sunken p-3 font-mono text-[11px] leading-5 text-muted-foreground/95 whitespace-pre-wrap break-all"
          >
            {content}
          </pre>
        </div>
      )}
    </div>
  );
}

function buildStatOnlyHunks(
  stat: NonNullable<ReturnType<typeof readWriteStat>>,
  LL: TranslationFunctions,
): PreviewDiffHunk[] {
  const hunks: PreviewDiffHunk[] = [];
  if (stat.removed > 0) {
    hunks.push({
      kind: "removed",
      value: `${LL.preview_removed_lines_unavailable(stat.removed)}\n`,
      lineCount: 1,
    });
  }
  if (stat.added > 0) {
    hunks.push({
      kind: "added",
      value: `${LL.preview_added_lines_unavailable(stat.added)}\n`,
      lineCount: 1,
    });
  }
  return hunks;
}

function changesToPreviewHunks(changes: Change[]): PreviewDiffHunk[] {
  let oldLine = 1;
  let newLine = 1;
  return changes.map((c) => {
    const kind: PreviewDiffHunk["kind"] = c.added
      ? "added"
      : c.removed
        ? "removed"
        : "context";
    const lineCount = c.count ?? countLines(c.value);
    const hunk: PreviewDiffHunk = {
      kind,
      value: c.value,
      lineCount,
      ...(kind !== "added" ? { oldStart: oldLine } : {}),
      ...(kind !== "removed" ? { newStart: newLine } : {}),
    };
    if (kind !== "added") oldLine += lineCount;
    if (kind !== "removed") newLine += lineCount;
    return hunk;
  });
}

// ---------------------------------------------------------------------------
// 注册表
// ---------------------------------------------------------------------------

function searchQuery(args: unknown): string {
  const a = asRecord(args);
  return typeof a?.query === "string" ? a.query : "";
}

interface WebSearchResultItem {
  title: string;
  url: string;
  snippet: string;
}

function webSearchResults(result: unknown): WebSearchResultItem[] {
  const r = asRecord(result);
  const results = Array.isArray(r?.results) ? r.results : [];
  return results
    .map((item): WebSearchResultItem | null => {
      const it = asRecord(item);
      const title = typeof it?.title === "string" ? it.title.trim() : "";
      const url = typeof it?.url === "string" ? it.url.trim() : "";
      const snippet =
        typeof it?.snippet === "string"
          ? it.snippet.trim()
          : typeof it?.content === "string"
            ? it.content.trim()
            : "";
      if (!title && !url && !snippet) return null;
      return { title, url, snippet };
    })
    .filter((item): item is WebSearchResultItem => item !== null);
}

function isHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function compactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const path = `${parsed.pathname}${parsed.search}`.replace(/\/$/, "");
    const shortPath = path.length > 48 ? `${path.slice(0, 48)}…` : path;
    return `${parsed.hostname}${shortPath}`;
  } catch {
    return url;
  }
}

function WebSearchResultList({ items }: { items: WebSearchResultItem[] }) {
  const link = useLinkRouter();
  return (
    <ol className="max-h-72 overflow-auto px-2.5 py-1.5 text-xs">
      {items.map((item, i) => {
        const href = isHttpUrl(item.url) ? item.url : "";
        const title = item.title || item.url || item.snippet;
        const urlText = item.url ? compactUrl(item.url) : "";
        return (
          <li
            key={item.url || `${title}-${i}`}
            className="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-1.5 border-border/40 border-t py-1.5 first:border-t-0"
          >
            <span className="pt-0.5 text-right font-mono text-[10px] text-muted-foreground tabular-nums">
              {i + 1}
            </span>
            <div className="min-w-0">
              {href ? (
                <a
                  href={href}
                  onClick={link.onClick}
                  onAuxClick={link.onAuxClick}
                  rel="noopener noreferrer"
                  className="block truncate font-medium text-foreground/75 hover:text-primary/85 hover:underline"
                >
                  {title}
                </a>
              ) : (
                <div className="truncate font-medium text-foreground/75">
                  {title}
                </div>
              )}
              {href && (
                <a
                  href={href}
                  onClick={link.onClick}
                  onAuxClick={link.onAuxClick}
                  rel="noopener noreferrer"
                  className="mt-0.5 block truncate text-muted-foreground/75 hover:text-primary/85 hover:underline"
                >
                  {urlText}
                </a>
              )}
              {item.snippet && (
                <div className="mt-0.5 line-clamp-2 text-muted-foreground/85 leading-snug">
                  {item.snippet}
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

const webSearchPresenter: ToolPresenter = {
  // 单次调用:显示查询词(使该行不只是"完成 webSearch")。
  summary: (args) => {
    const q = searchQuery(args);
    if (!q) return null;
    return <span className={TOOL_SUMMARY_TEXT}>{q}</span>;
  },
  // 折叠分组:列出每次调用的查询词,而不是"5 个 webSearch"。
  groupSummary: (argsList) => {
    const queries = argsList.map(searchQuery).filter(Boolean);
    if (!queries.length) return null;
    return <span className={TOOL_SUMMARY_TEXT}>{queries.join("、")}</span>;
  },
  // 展开输出:排序后的结果(标题 + url)。
  output: (result) => {
    const results = webSearchResults(result);
    if (!results.length) return null;
    return <WebSearchResultList items={results} />;
  },
};

const searchFilesPresenter: ToolPresenter = {
  summary: (args) => {
    const q = searchQuery(args).trim();
    if (!q) return null;
    return <span className={TOOL_SUMMARY_TEXT}>{q}</span>;
  },
  groupSummary: (argsList) => {
    const queries = argsList
      .map((args) => searchQuery(args).trim())
      .filter(Boolean);
    if (!queries.length) return null;
    return <span className={TOOL_SUMMARY_TEXT}>{queries.join("、")}</span>;
  },
};

// --- 没有丰富输出的文件操作:仅呈现目标路径,使折叠行显示为
//     "移动文件 a → b",而不是单纯的"完成 moveFile"。

const moveFilePresenter: ToolPresenter = {
  summary: (args, _result, _state, { workspacePath }) => {
    const a = asRecord(args);
    const src = typeof a?.source === "string" ? a.source : "";
    const dst = typeof a?.destination === "string" ? a.destination : "";
    if (!src && !dst) return null;
    return (
      <span className={TOOL_SUMMARY_TEXT} title={`${src} → ${dst}`}>
        {displayPath(src, workspacePath)}{" "}
        <span className={TOOL_MUTED_TEXT}>→</span>{" "}
        {displayPath(dst, workspacePath)}
      </span>
    );
  },
};

function pathOnlySummary(
  args: unknown,
  _result: unknown,
  _state: ToolState,
  ctx: PresenterCtx,
): ReactNode | null {
  const a = asRecord(args);
  const p = typeof a?.path === "string" ? a.path : "";
  return p ? (
    <span className={TOOL_SUMMARY_TEXT} title={p}>
      {displayPath(p, ctx.workspacePath)}
    </span>
  ) : null;
}

const deleteFilePresenter: ToolPresenter = { summary: pathOnlySummary };
const createDirectoryPresenter: ToolPresenter = { summary: pathOnlySummary };

const directoryStatsPresenter: ToolPresenter = {
  summary: (args, result, state, { LL, workspacePath }) => {
    const a = asRecord(args);
    const p = typeof a?.path === "string" ? a.path : "";
    const r = asRecord(result);
    const files = typeof r?.totalFiles === "number" ? r.totalFiles : null;
    const dirs = typeof r?.totalDirs === "number" ? r.totalDirs : null;
    return (
      <>
        <span className={TOOL_SUMMARY_TEXT} title={p}>
          {displayPath(p, workspacePath)}
        </span>
        {state === "output-available" && files !== null && dirs !== null && (
          <span className={cn("ml-2", TOOL_MUTED_TEXT)}>
            {LL.tool_summary_dirs_files(dirs, files)}
          </span>
        )}
      </>
    );
  },
};

// --- 以 `url` 参数为键的 Web 工具:显示主机/路径,分组时逐一列出。 ---

function urlArg(args: unknown): string {
  const a = asRecord(args);
  return typeof a?.url === "string" ? a.url : "";
}

function shortUrl(u: string, max = 60): string {
  if (!u) return u;
  const stripped = u.replace(/^https?:\/\//, "");
  return stripped.length > max ? `${stripped.slice(0, max)}…` : stripped;
}

const urlGroupSummary = (argsList: unknown[]): ReactNode | null => {
  const urls = argsList
    .map(urlArg)
    .filter(Boolean)
    .map((u) => shortUrl(u, 40));
  if (!urls.length) return null;
  return <span className={TOOL_SUMMARY_TEXT}>{urls.join("、")}</span>;
};

const urlPresenter: ToolPresenter = {
  summary: (args) => {
    const u = urlArg(args);
    return u ? <span className={TOOL_SUMMARY_TEXT}>{shortUrl(u)}</span> : null;
  },
  groupSummary: urlGroupSummary,
};

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value.filter(
        (item): item is string =>
          typeof item === "string" && item.trim().length > 0,
      ),
    ),
  );
}

function matchCount(result: Record<string, unknown>): number {
  const matchedPages = result.matchedPages;
  const matchedChunks = result.matchedChunks;
  if (Array.isArray(matchedPages)) return matchedPages.length;
  if (Array.isArray(matchedChunks)) return matchedChunks.length;
  if (typeof matchedPages === "number") return matchedPages;
  return typeof matchedChunks === "number" ? matchedChunks : 0;
}

function WebFetchOutput({
  result,
  args,
  LL,
}: {
  result: unknown;
  args: unknown;
  LL: TranslationFunctions;
}) {
  const r = asRecord(result);
  const a = asRecord(args);
  const link = useLinkRouter();
  if (!r) return null;

  const url =
    typeof r.url === "string" ? r.url : typeof a?.url === "string" ? a.url : "";
  const title = typeof r.title === "string" ? r.title.trim() : "";
  const excerpt = typeof r.excerpt === "string" ? r.excerpt.trim() : "";
  const error = typeof r.error === "string" ? r.error.trim() : "";
  const contentType =
    typeof r.contentType === "string" ? r.contentType.split(";")[0] : "";
  const status = typeof r.status === "number" ? r.status : null;
  const statusText =
    typeof r.statusText === "string" ? r.statusText.trim() : "";
  const pages = typeof r.pages === "number" ? r.pages : 0;
  const matches = matchCount(r);
  const fullContent =
    typeof r.markdown === "string" && r.markdown.trim()
      ? r.markdown.trim()
      : typeof r.raw === "string" && r.raw.trim()
        ? r.raw.trim()
        : typeof r.content === "string" && r.content.trim()
          ? r.content.trim()
          : "";
  const clippedByUi = fullContent.length > MAX_WEB_CONTENT_CHARS;
  const content = clippedByUi
    ? `${fullContent.slice(0, MAX_WEB_CONTENT_CHARS).trimEnd()}\n…`
    : fullContent;
  const truncated = r.truncated === true || clippedByUi;
  const href = isHttpUrl(url) ? url : "";
  const statusLabel =
    status === null ? "" : `${status}${statusText ? ` ${statusText}` : ""}`;
  const statusTone =
    status !== null && status >= 400
      ? "border-status-error/25 bg-status-error/8 text-status-error/80"
      : "border-status-success/20 bg-status-success/8 text-status-success/80";

  return (
    <div
      data-web-fetch-output="true"
      data-web-fetch-truncated={truncated ? "true" : undefined}
      className="bg-surface-sunken/35 text-xs"
    >
      <div className="border-border-faint border-b px-3 py-2.5">
        <div className="flex min-w-0 items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="truncate font-medium text-foreground/85">
              {title || shortUrl(url, 90) || LL.tool_webFetch_content()}
            </div>
            {href ? (
              <a
                href={href}
                onClick={link.onClick}
                onAuxClick={link.onAuxClick}
                rel="noopener noreferrer"
                className="mt-0.5 block truncate text-[11px] text-muted-foreground/75 hover:text-primary/85 hover:underline"
              >
                {compactUrl(url)}
              </a>
            ) : url ? (
              <div className="mt-0.5 truncate text-[11px] text-muted-foreground/75">
                {url}
              </div>
            ) : null}
          </div>
          {statusLabel && (
            <span
              className={cn(
                "shrink-0 rounded-sm border px-1.5 py-0.5 font-mono text-[10px] tabular-nums",
                statusTone,
              )}
            >
              {statusLabel}
            </span>
          )}
        </div>
        {excerpt && (
          <p className="mt-2 line-clamp-3 leading-relaxed text-muted-foreground/90">
            {excerpt}
          </p>
        )}
        {(contentType || pages > 0 || matches > 0 || truncated) && (
          <div className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1 font-mono text-[10px] text-muted-foreground/65">
            {contentType && <span>{contentType}</span>}
            {pages > 0 && <span>{LL.tool_webFetch_pages(pages)}</span>}
            {matches > 0 && <span>{LL.tool_webFetch_matches(matches)}</span>}
            {truncated && (
              <span className="text-status-await/80">
                {LL.tool_webFetch_truncated()}
              </span>
            )}
          </div>
        )}
      </div>

      {error ? (
        <div className="border-status-error/20 border-l-2 px-3 py-2.5 leading-relaxed text-status-error/85">
          {error}
        </div>
      ) : content ? (
        <section aria-label={LL.tool_webFetch_content()}>
          <div className="border-border-faint border-b px-3 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground/60">
            {LL.tool_webFetch_content()}
          </div>
          <pre className="max-h-72 overflow-auto px-3 py-2.5 font-mono text-[11px] leading-5 whitespace-pre-wrap break-words text-muted-foreground/95">
            {renderWithLinks(content, link)}
          </pre>
        </section>
      ) : (
        <div className="px-3 py-3 italic text-muted-foreground/70">
          {LL.tool_webFetch_empty()}
        </div>
      )}
    </div>
  );
}

interface SubmissionFinding {
  claim: string;
  evidence: string[];
}

interface SubmissionPayload {
  status: "complete" | "partial" | "no_result";
  coverage: string[];
  findings: SubmissionFinding[];
  evidence: string[];
  missing: string[];
  failureReason: string;
}

function submissionPayload(value: unknown): SubmissionPayload | null {
  const root = asRecord(value);
  const payload = asRecord(root?.artifacts) ?? root;
  if (!payload) return null;
  const status = payload.status;
  if (status !== "complete" && status !== "partial" && status !== "no_result") {
    return null;
  }
  const findings = Array.isArray(payload.findings)
    ? payload.findings
        .map((item): SubmissionFinding | null => {
          const finding = asRecord(item);
          const claim =
            typeof finding?.claim === "string" ? finding.claim.trim() : "";
          if (!claim) return null;
          return { claim, evidence: stringArray(finding?.evidence) };
        })
        .filter((item): item is SubmissionFinding => item !== null)
    : [];
  return {
    status,
    coverage: stringArray(payload.coverage),
    findings,
    evidence: stringArray(payload.evidence),
    missing: stringArray(payload.missing),
    failureReason:
      typeof payload.failureReason === "string"
        ? payload.failureReason.trim()
        : "",
  };
}

function SubmissionList({
  items,
  tone = "default",
}: {
  items: string[];
  tone?: "default" | "warning";
}) {
  const link = useLinkRouter();
  return (
    <ul className="space-y-1.5">
      {items.map((item) => (
        <li
          key={item}
          className="grid grid-cols-[0.75rem_minmax(0,1fr)] gap-1.5 leading-relaxed"
        >
          <span
            className={cn(
              "pt-px text-muted-foreground/45",
              tone === "warning" && "text-status-await/75",
            )}
          >
            •
          </span>
          <span>{renderWithLinks(item, link)}</span>
        </li>
      ))}
    </ul>
  );
}

function SubmissionResult({
  payload,
  LL,
}: {
  payload: SubmissionPayload;
  LL: TranslationFunctions;
}) {
  const statusLabel =
    payload.status === "complete"
      ? LL.tool_submit_complete()
      : payload.status === "partial"
        ? LL.tool_submit_partial()
        : LL.tool_submit_noResult();
  const statusTone =
    payload.status === "complete"
      ? "border-status-success/25 bg-status-success/8 text-status-success/85"
      : payload.status === "partial"
        ? "border-status-await/25 bg-status-await/8 text-status-await/85"
        : "border-status-error/25 bg-status-error/8 text-status-error/85";

  return (
    <div
      data-subagent-result={payload.status}
      className="bg-surface-sunken/35 text-xs"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-border-faint border-b px-3 py-2">
        <span
          className={cn(
            "rounded-sm border px-1.5 py-0.5 text-[10px] font-medium",
            statusTone,
          )}
        >
          {statusLabel}
        </span>
        <span className="font-mono text-[10px] text-muted-foreground/65">
          {payload.findings.length} {LL.tool_submit_findings()} ·{" "}
          {payload.evidence.length} {LL.tool_submit_evidence()}
        </span>
      </div>

      {payload.coverage.length > 0 && (
        <section className="border-border-faint border-b px-3 py-2.5">
          <h4 className="mb-1.5 text-[10px] uppercase tracking-wider text-muted-foreground/60">
            {LL.tool_submit_coverage()}
          </h4>
          <div className="flex flex-wrap gap-1.5">
            {payload.coverage.map((item) => (
              <span
                key={item}
                className="rounded-sm border border-border/55 bg-background/45 px-1.5 py-0.5 text-[11px] text-foreground/70"
              >
                {item}
              </span>
            ))}
          </div>
        </section>
      )}

      {payload.findings.length > 0 && (
        <section className="border-border-faint border-b px-3 py-2.5">
          <h4 className="mb-2 text-[10px] uppercase tracking-wider text-muted-foreground/60">
            {LL.tool_submit_findings()}
          </h4>
          <ol className="space-y-2.5">
            {payload.findings.map((finding, index) => (
              <li
                key={`${finding.claim}-${finding.evidence.join("\u0000")}`}
                className="grid grid-cols-[1.25rem_minmax(0,1fr)] gap-1.5"
              >
                <span className="pt-0.5 text-right font-mono text-[10px] text-muted-foreground/55 tabular-nums">
                  {index + 1}
                </span>
                <div className="min-w-0">
                  <p className="font-medium leading-relaxed text-foreground/85">
                    {finding.claim}
                  </p>
                  {finding.evidence.length > 0 && (
                    <div className="mt-1 border-border/50 border-l pl-2 text-[11px] text-muted-foreground/85">
                      <SubmissionList items={finding.evidence} />
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </section>
      )}

      {payload.evidence.length > 0 && (
        <section className="border-border-faint border-b px-3 py-2.5 text-muted-foreground/90">
          <h4 className="mb-1.5 text-[10px] uppercase tracking-wider text-muted-foreground/60">
            {LL.tool_submit_evidence()}
          </h4>
          <SubmissionList items={payload.evidence} />
        </section>
      )}

      {payload.missing.length > 0 && (
        <section className="border-status-await/25 border-l-2 px-3 py-2.5 text-muted-foreground/90">
          <h4 className="mb-1.5 text-[10px] uppercase tracking-wider text-status-await/75">
            {LL.tool_submit_missing()}
          </h4>
          <SubmissionList items={payload.missing} tone="warning" />
        </section>
      )}

      {payload.failureReason && (
        <section className="border-status-error/20 border-t px-3 py-2.5 text-status-error/85">
          <h4 className="mb-1 text-[10px] uppercase tracking-wider text-status-error/70">
            {LL.tool_submit_failure()}
          </h4>
          <p className="leading-relaxed">{payload.failureReason}</p>
        </section>
      )}
    </div>
  );
}

const webFetchPresenter: ToolPresenter = {
  summary: (args) => {
    const u = urlArg(args);
    if (!u) return null;
    const a = asRecord(args);
    const q = typeof a?.query === "string" ? a.query : "";
    return (
      <span className={TOOL_SUMMARY_TEXT}>
        {shortUrl(u)}
        {q && <span className={cn("ml-2", TOOL_MUTED_TEXT)}>🔍 {q}</span>}
      </span>
    );
  },
  groupSummary: urlGroupSummary,
  output: (result, args, _state, { LL }) => (
    <WebFetchOutput result={result} args={args} LL={LL} />
  ),
};

const submitSubagentResultPresenter: ToolPresenter = {
  summary: (args, result, _state, { LL }) => {
    const payload = submissionPayload(result) ?? submissionPayload(args);
    if (!payload) return null;
    const status =
      payload.status === "complete"
        ? LL.tool_submit_complete()
        : payload.status === "partial"
          ? LL.tool_submit_partial()
          : LL.tool_submit_noResult();
    return (
      <span className={TOOL_SUMMARY_TEXT}>
        {status}
        {payload.findings.length > 0 && (
          <span className={cn("ml-2", TOOL_MUTED_TEXT)}>
            {payload.findings.length} {LL.tool_submit_findings()}
          </span>
        )}
      </span>
    );
  },
  // The tool result is normally just an acknowledgement. Render the submitted
  // payload from persisted args, while preferring normalized result artifacts
  // when a provider returns them.
  output: (result, args, _state, { LL }) => {
    const payload = submissionPayload(result) ?? submissionPayload(args);
    return payload ? <SubmissionResult payload={payload} LL={LL} /> : null;
  },
};

const sanitizedBrowserUrl = (raw: unknown): string => {
  if (typeof raw !== "string" || raw.length === 0) return "";
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    return url.href;
  } catch {
    return "[invalid URL]";
  }
};

const browserOrigin = (raw: unknown): string => {
  const safe = sanitizedBrowserUrl(raw);
  if (!safe || safe === "[invalid URL]") return safe;
  try {
    return new URL(safe).origin;
  } catch {
    return "[invalid URL]";
  }
};

const browserTargetSummary = (
  args: Record<string, unknown> | null,
  result: Record<string, unknown> | null,
): string => {
  const ref = typeof args?.ref === "string" ? args.ref : "";
  if (!ref) return "";
  const elements = Array.isArray(result?.elements) ? result.elements : [];
  const target = elements.map(asRecord).find((element) => element?.ref === ref);
  const name = typeof target?.name === "string" ? target.name : "";
  return name ? `${name} · ${ref}` : ref;
};

const browserPresenter = (action: string): ToolPresenter => ({
  summary: (args, result, state) => {
    const a = asRecord(args);
    const r = asRecord(result);
    const rawUrl = r?.url ?? a?.url;
    const origin = browserOrigin(rawUrl);
    const tabId =
      typeof r?.tabId === "string"
        ? r.tabId
        : typeof a?.tabId === "string"
          ? a.tabId
          : "";
    const target = browserTargetSummary(a, r);
    const execution =
      state === "output-available"
        ? "done"
        : state === "output-error"
          ? "failed"
          : "pending";
    return (
      <span data-browser-tool-summary={action} className={TOOL_SUMMARY_TEXT}>
        {origin || action}
        <span className={cn("ml-2", TOOL_MUTED_TEXT)}>{action}</span>
        {target && (
          <span className={cn("ml-2", TOOL_MUTED_TEXT)}>{target}</span>
        )}
        {tabId && (
          <span className={cn("ml-2 font-mono", TOOL_MUTED_TEXT)}>{tabId}</span>
        )}
        <span
          className={cn(
            "ml-2",
            execution === "failed" ? TOOL_ERROR_TEXT : TOOL_MUTED_TEXT,
          )}
        >
          {execution}
        </span>
      </span>
    );
  },
  input: (args) => {
    const a = asRecord(args);
    if (!a) return null;
    const rows = [
      typeof a.url === "string" ? ["URL", sanitizedBrowserUrl(a.url)] : null,
      typeof a.tabId === "string" ? ["Tab", a.tabId] : null,
      typeof a.navigationId === "string"
        ? ["Navigation", a.navigationId]
        : null,
      typeof a.snapshotId === "string" ? ["Snapshot", a.snapshotId] : null,
      typeof a.ref === "string" ? ["Target ref", a.ref] : null,
      typeof a.key === "string" ? ["Key", a.key] : null,
    ].filter((row): row is string[] => row !== null);
    if (rows.length === 0) return null;
    return (
      <dl
        data-browser-tool-input={action}
        className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 border-border/35 border-b px-3 py-2 text-xs"
      >
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className={TOOL_MUTED_TEXT}>{label}</dt>
            <dd className="truncate font-mono text-foreground/70" title={value}>
              {value}
            </dd>
          </div>
        ))}
      </dl>
    );
  },
  output: (result) => {
    const r = asRecord(result);
    if (!r) return null;
    const url = sanitizedBrowserUrl(r.url);
    const title = typeof r.title === "string" ? r.title : "";
    const snapshotId = typeof r.snapshotId === "string" ? r.snapshotId : "";
    const elements = Array.isArray(r.elements) ? r.elements.length : 0;
    if (!url && !title && !snapshotId && elements === 0) return null;
    return (
      <div
        data-browser-tool-output={action}
        className="space-y-1 bg-surface-sunken/35 px-3 py-2 text-xs text-muted-foreground"
      >
        {title && <div className="font-medium text-foreground/75">{title}</div>}
        {url && <div className="truncate font-mono">{url}</div>}
        <div className="flex gap-3 text-[10px]">
          {snapshotId && <span>snapshot {snapshotId}</span>}
          <span>{elements} refs</span>
        </div>
      </div>
    );
  },
});

const browserTabsPresenter: ToolPresenter = {
  summary: (_args, result) => {
    const r = asRecord(result);
    const tabs = Array.isArray(r?.tabs) ? r.tabs : [];
    const activeTabId = typeof r?.activeTabId === "string" ? r.activeTabId : "";
    return (
      <span data-browser-tool-summary="tabs" className={TOOL_SUMMARY_TEXT}>
        {tabs.length} tabs
        {activeTabId && (
          <span className={cn("ml-2 font-mono", TOOL_MUTED_TEXT)}>
            active {activeTabId}
          </span>
        )}
      </span>
    );
  },
  output: (result) => {
    const r = asRecord(result);
    const tabs = Array.isArray(r?.tabs)
      ? r.tabs.map(asRecord).filter(Boolean)
      : [];
    if (tabs.length === 0) return null;
    return (
      <div
        data-browser-tool-output="tabs"
        className="space-y-1 px-3 py-2 text-xs"
      >
        {tabs.map((tab, index) => {
          const id = typeof tab?.id === "string" ? tab.id : `tab-${index}`;
          const url = sanitizedBrowserUrl(tab?.url);
          const title = typeof tab?.title === "string" ? tab.title : "";
          return (
            <div key={id} className="flex min-w-0 gap-2 text-muted-foreground">
              <span className="shrink-0 font-mono">{id}</span>
              <span className="truncate">{title || url}</span>
              {tab?.active === true && <span className="shrink-0">active</span>}
            </div>
          );
        })}
      </div>
    );
  },
};

export const toolPresenters: Record<string, ToolPresenter> = {
  runCommand: runCommandPresenter,
  readFile: readFilePresenter,
  listDirectory: listDirectoryPresenter,
  writeFile: writeFilePresenter,
  readShellOutput: readShellOutputPresenter,
  killShell: killShellPresenter,
  webSearch: webSearchPresenter,
  searchFiles: searchFilesPresenter,
  moveFile: moveFilePresenter,
  deleteFile: deleteFilePresenter,
  createDirectory: createDirectoryPresenter,
  directoryStats: directoryStatsPresenter,
  webFetch: webFetchPresenter,
  webFetchRendered: webFetchPresenter,
  webScrape: webFetchPresenter,
  browserOpen: browserPresenter("open"),
  browserTabs: browserTabsPresenter,
  browserSwitchTab: browserPresenter("switch"),
  browserSnapshot: browserPresenter("snapshot"),
  browserClick: browserPresenter("click"),
  browserType: browserPresenter("type"),
  browserPress: browserPresenter("press"),
  browserScroll: browserPresenter("scroll"),
  browserClose: browserPresenter("close"),
  youtubeTranscript: urlPresenter,
  submitSubagentResult: submitSubagentResultPresenter,
};
