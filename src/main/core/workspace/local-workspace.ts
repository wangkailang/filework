/**
 * LocalWorkspace — 基于本地文件系统目录的工作区。
 *
 * 沙箱语义:每个相对路径都相对工作区根目录解析,并通过
 * `node:fs.realpath` 校验,从而捕获符号链接逃逸。`toRelative()` 会以
 * `WorkspaceEscapeError` 拒绝解析后落在根目录之外的绝对路径。该逻辑
 * 与 `src/main/ipc/ai-tool-permissions.ts:27-59` 的 M1 之前的检查一致,
 * 上提到工作区中,使所有工具免费继承。
 */

import { spawn } from "node:child_process";
import {
  access,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import {
  buildSeatbeltProfile,
  getSandboxLauncher,
  isSandboxEffective,
} from "../sandbox";
import type {
  ExecOptions,
  ExecResult,
  FileStat,
  ListOptions,
  MkdirOptions,
  ReadFileOptions,
  RmOptions,
  Workspace,
  WorkspaceEntry,
  WorkspaceExec,
  WorkspaceFS,
  WorkspaceKind,
} from "./types";
import { WorkspaceEscapeError } from "./types";

const DEFAULT_EXEC_TIMEOUT_MS = 5 * 60 * 1000;

// runCommand 输出上限 —— 在工具边界、抵达模型*之前*施加,与 Codex/Claude
// Code 一致。这样失控的 `cat bigfile` 只会给上下文增加约 32KB,而非数 MB
//(多步循环每轮都会重发这些内容,导致输入 token 暴涨)。同时保留头部和
// 尾部 —— 退出信息 / 最终错误位于结尾。即使面对 100MB 的流,峰值内存也
// 维持在 HEAD+TAIL。
const EXEC_OUT_HEAD = 24_000;
const EXEC_OUT_TAIL = 8_000;

/** 对流式输出进行内存受限的头部+尾部捕获。 */
class BoundedCapture {
  private head = "";
  private tail = "";
  private total = 0;

  push(chunk: string): void {
    this.total += chunk.length;
    if (this.head.length < EXEC_OUT_HEAD) {
      const room = EXEC_OUT_HEAD - this.head.length;
      this.head += chunk.slice(0, room);
      chunk = chunk.slice(room);
    }
    if (chunk) this.tail = (this.tail + chunk).slice(-EXEC_OUT_TAIL);
  }

  get truncated(): boolean {
    return this.total > EXEC_OUT_HEAD + EXEC_OUT_TAIL;
  }

  /** 在预算内时重建完整文本,否则返回 head…tail。 */
  value(): string {
    if (!this.truncated) return this.head + this.tail;
    const dropped = this.total - this.head.length - this.tail.length;
    return `${this.head}\n…[truncated ${dropped} chars]…\n${this.tail}`;
  }
}

/**
 * 将绝对路径 `p` 投影为其规范(解析符号链接后)形式,即使 `p` 尚不
 * 存在。我们向上回溯到最深的已存在祖先,对其做 realpath,再拼回未解析
 * 的尾部。
 *
 * 在 macOS 上这点很重要,因为 `/tmp/x/y/z` 与其 realpath
 * `/private/var/folders/.../x/y/z` 是不同的前缀 —— 拿未解析的 `joined`
 * 去和 `realRoot` 比较会始终被拒绝。
 */
async function projectRealPath(p: string): Promise<string> {
  let current = p;
  const tail: string[] = [];

  while (true) {
    try {
      const realCurrent = await realpath(current);
      if (tail.length === 0) return realCurrent;
      return path.join(realCurrent, ...tail.slice().reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        // 一直到达文件系统根仍未解析出任何内容。
        return p;
      }
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

function isInsideRoot(target: string, realRoot: string): boolean {
  return target === realRoot || target.startsWith(realRoot + path.sep);
}

/** 在 `root` 内解析路径,并校验其在符号链接解析后未发生逃逸。 */
async function resolveInside(
  root: string,
  rel: string,
  realRoot: string,
): Promise<string> {
  const joined = path.resolve(root, rel);
  const realTarget = await projectRealPath(joined);
  if (!isInsideRoot(realTarget, realRoot)) {
    throw new WorkspaceEscapeError(rel, realRoot);
  }
  return joined;
}

class LocalWorkspaceFS implements WorkspaceFS {
  constructor(
    private readonly root: string,
    private readonly realRootPromise: Promise<string>,
  ) {}

  private async inside(rel: string): Promise<string> {
    const realRoot = await this.realRootPromise;
    return resolveInside(this.root, rel, realRoot);
  }

  async readFile(
    rel: string,
    opts?: ReadFileOptions,
  ): Promise<string | Uint8Array> {
    const abs = await this.inside(rel);
    if (opts?.encoding === "binary") {
      return readFile(abs);
    }
    return readFile(abs, "utf-8");
  }

  async writeFile(rel: string, content: string | Uint8Array): Promise<void> {
    const abs = await this.inside(rel);
    await mkdir(path.dirname(abs), { recursive: true });
    if (typeof content === "string") {
      await writeFile(abs, content, "utf-8");
    } else {
      await writeFile(abs, content);
    }
  }

  async exists(rel: string): Promise<boolean> {
    try {
      const abs = await this.inside(rel);
      await access(abs);
      return true;
    } catch {
      return false;
    }
  }

  async stat(rel: string): Promise<FileStat> {
    const abs = await this.inside(rel);
    const s = await stat(abs);
    return { size: s.size, mtime: s.mtime, isDirectory: s.isDirectory() };
  }

  async list(rel: string, opts?: ListOptions): Promise<WorkspaceEntry[]> {
    const abs = await this.inside(rel);
    const realRoot = await this.realRootPromise;
    const entries = await readdir(abs, {
      withFileTypes: true,
      recursive: opts?.recursive ?? false,
    });
    const results: WorkspaceEntry[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const fullPath = path.join(entry.parentPath || abs, entry.name);
      const relPath = path.relative(realRoot, fullPath);
      try {
        const s = await stat(fullPath);
        results.push({
          name: entry.name,
          path: relPath.split(path.sep).join("/"),
          isDirectory: entry.isDirectory(),
          size: s.size,
          extension: entry.isDirectory() ? "" : path.extname(entry.name),
          modifiedAt: s.mtime.toISOString(),
        });
      } catch {
        // 跳过不可访问的项
      }
    }
    return results.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }

  async mkdir(rel: string, opts?: MkdirOptions): Promise<void> {
    const abs = await this.inside(rel);
    await mkdir(abs, { recursive: opts?.recursive ?? true });
  }

  async rm(rel: string, opts?: RmOptions): Promise<void> {
    const abs = await this.inside(rel);
    await rm(abs, { recursive: opts?.recursive ?? false, force: false });
  }

  async rename(fromRel: string, toRel: string): Promise<void> {
    const fromAbs = await this.inside(fromRel);
    const toAbs = await this.inside(toRel);
    await mkdir(path.dirname(toAbs), { recursive: true });
    await rename(fromAbs, toAbs);
  }

  resolve(rel: string): string {
    return path.resolve(this.root, rel);
  }

  async toRelative(abs: string): Promise<string> {
    const realRoot = await this.realRootPromise;
    const realTarget = await projectRealPath(path.resolve(abs));
    if (!isInsideRoot(realTarget, realRoot)) {
      throw new WorkspaceEscapeError(abs, realRoot);
    }
    return path.relative(realRoot, realTarget).split(path.sep).join("/");
  }
}

class LocalWorkspaceExec implements WorkspaceExec {
  constructor(
    private readonly root: string,
    private readonly fs: LocalWorkspaceFS,
  ) {}

  private async cwdAbs(opts?: ExecOptions): Promise<string> {
    let cwdAbs = this.root;
    if (opts?.cwd) {
      const candidate = path.isAbsolute(opts.cwd)
        ? opts.cwd
        : path.resolve(this.root, opts.cwd);
      const rel = await this.fs.toRelative(candidate);
      cwdAbs = this.fs.resolve(rel);
    }
    return cwdAbs;
  }

  private async spawnAndCapture(
    launch: { file: string; args: string[]; shell?: boolean },
    cwdAbs: string,
    opts?: ExecOptions,
  ): Promise<ExecResult> {
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;

    return new Promise<ExecResult>((resolve, reject) => {
      let settled = false;
      let killTimer: ReturnType<typeof setTimeout> | null = null;
      let timeoutTimer: ReturnType<typeof setTimeout> | null = null;

      const settle = (value: ExecResult | Error, asError = false) => {
        if (settled) return;
        settled = true;
        if (killTimer) clearTimeout(killTimer);
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (asError) reject(value as Error);
        else resolve(value as ExecResult);
      };

      const child = spawn(launch.file, launch.args, {
        cwd: cwdAbs,
        shell: launch.shell ?? false,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
        // BROWSER=none 防止开发服务器(Vite / CRA / Next / Astro)
        // 自动拉起操作系统默认浏览器。URL 会出现在 stdout 中,由用户
        // 点击后在应用内的 BrowserPanel 打开。仅当用户未显式选择
        // BROWSER 时设置 —— 尊重 `BROWSER=firefox-dev` 之类的个性化配置。
        env: {
          ...process.env,
          BROWSER: process.env.BROWSER ?? "none",
        },
      });

      const terminate = (signal: NodeJS.Signals) => {
        if (!child.pid) return;
        try {
          if (process.platform !== "win32") {
            process.kill(-child.pid, signal);
          } else {
            spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
              stdio: "ignore",
              windowsHide: true,
            });
          }
        } catch {
          try {
            process.kill(child.pid, signal);
          } catch {
            // 进程已不存在
          }
        }
      };

      const outCap = new BoundedCapture();
      const errCap = new BoundedCapture();
      child.stdout?.on("data", (data) => outCap.push(data.toString()));
      child.stderr?.on("data", (data) => errCap.push(data.toString()));

      const buildResult = (
        exitCode: number,
        stderrSuffix = "",
      ): ExecResult => ({
        stdout: outCap.value(),
        stderr: errCap.value() + stderrSuffix,
        exitCode,
        ...(outCap.truncated || errCap.truncated
          ? { outputTruncated: true }
          : {}),
      });

      child.on("close", (code) => {
        settle(buildResult(code ?? 0));
      });
      child.on("error", (error) => settle(error, true));

      timeoutTimer = setTimeout(() => {
        if (settled) return;
        terminate("SIGTERM");
        killTimer = setTimeout(() => terminate("SIGKILL"), 2000);
        settle(buildResult(124, `\nCommand timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      const onAbort = () => {
        if (settled) return;
        terminate("SIGTERM");
        killTimer = setTimeout(() => terminate("SIGKILL"), 2000);
        settle(buildResult(130, "\nCommand was cancelled"));
      };
      if (opts?.signal) {
        if (opts.signal.aborted) onAbort();
        else opts.signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }

  async run(command: string, opts?: ExecOptions): Promise<ExecResult> {
    const cwdAbs = await this.cwdAbs(opts);
    // 沙箱包裹:有 policy 走 launcher(darwin 上 sandbox-exec),
    // 无 policy 则 passthrough,等价旧的 `spawn(command, [], {shell:true})`。
    const launch = opts?.sandbox
      ? getSandboxLauncher(opts.sandbox).buildSpawn(command, { cwd: cwdAbs })
      : { file: command, args: [], shell: true };
    return this.spawnAndCapture(launch, cwdAbs, opts);
  }

  async runProcess(
    executable: string,
    args: string[] = [],
    opts?: ExecOptions,
  ): Promise<ExecResult> {
    const cwdAbs = await this.cwdAbs(opts);
    const launch =
      opts?.sandbox && isSandboxEffective(opts.sandbox.mode)
        ? {
            file: "/usr/bin/sandbox-exec",
            args: [
              "-p",
              buildSeatbeltProfile(opts.sandbox),
              executable,
              ...args,
            ],
            shell: false,
          }
        : { file: executable, args, shell: false };
    return this.spawnAndCapture(launch, cwdAbs, opts);
  }
}

export interface LocalWorkspaceOptions {
  /** 该工作区的稳定 id。默认为 `local:<absolute-root>`。 */
  id?: string;
}

export class LocalWorkspace implements Workspace {
  readonly kind: WorkspaceKind = "local";
  readonly id: string;
  readonly root: string;
  readonly fs: WorkspaceFS;
  readonly exec: WorkspaceExec;

  constructor(rootPath: string, opts?: LocalWorkspaceOptions) {
    this.root = path.resolve(rootPath);
    this.id = opts?.id ?? `local:${this.root}`;
    const realRootPromise = realpath(this.root);
    const fsImpl = new LocalWorkspaceFS(this.root, realRootPromise);
    this.fs = fsImpl;
    this.exec = new LocalWorkspaceExec(this.root, fsImpl);
  }
}
