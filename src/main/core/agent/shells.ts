/**
 * 长时运行命令的后台 shell 注册表。
 *
 * 对应 Claude Code 的 `Bash(run_in_background=true)` / `BashOutput` /
 * `KillShell` 三件套:运行 `pnpm dev`(或任意 server / watcher)的 agent
 * 会立即拿到一个 `shellId`,随后通过 `readShell` 轮询增量输出,完成后
 * 通过 `killShell` 拆除进程。
 *
 * 缓冲区按流分别设上限(stdout 1 MB + stderr 1 MB)。超过上限时丢弃最旧的
 * 256 KB —— 长时运行的 server 其 stdout 不会无限增长,但近期上下文始终可见。
 *
 * 生命周期:shell 的存活时间长于派生它的 agent 任务(刻意如此 ——
 * `pnpm dev` 会跨多个回合持续运行)。它们在应用 `before-quit` 时
 * 通过 {@link killAllShells} 清理。
 */

import { type ChildProcess, spawn } from "node:child_process";

import { getSandboxLauncher } from "../sandbox";
import type { SandboxPolicy } from "../sandbox/types";

const MAX_BUFFER = 1_000_000;
const DROP_CHUNK = 256_000;
const DEFAULT_INITIAL_WINDOW_MS = 2000;

export interface ShellEntry {
  id: string;
  command: string;
  cwd: string;
  pid: number | null;
  startedAt: number;
  status: "running" | "exited";
  exitCode: number | null;
}

interface InternalShell extends ShellEntry {
  child: ChildProcess;
  stdoutBuf: string;
  stderrBuf: string;
  /** 按流记录的读取偏移。单调递增;调用方只会看到自上次 `readShell`
   *  调用以来产生的输出。 */
  readOffsetStdout: number;
  readOffsetStderr: number;
}

const shells = new Map<string, InternalShell>();
let counter = 0;

function appendCapped(buf: string, chunk: string): string {
  const next = buf + chunk;
  if (next.length <= MAX_BUFFER) return next;
  return next.slice(Math.max(DROP_CHUNK, next.length - MAX_BUFFER));
}

export interface SpawnBackgroundOptions {
  /** 返回前捕获初始输出的时长(毫秒)。默认 2000。
   *  若子进程提前退出则更早返回。 */
  initialWindowMs?: number;
  /** 叠加在 process.env 之上的环境变量覆盖。 */
  env?: NodeJS.ProcessEnv;
  /**
   * OS 沙箱策略。提供则把命令包进 sandbox-exec(darwin)等;
   * 不提供则裸调用(内部基础设施调用保持旧行为)。
   */
  sandbox?: SandboxPolicy;
}

export interface SpawnBackgroundResult {
  shellId: string;
  pid: number | null;
  status: "running" | "exited";
  exitCode: number | null;
  /** 初始窗口期间捕获的 stdout(不消费 —— 下一次 readShell 仍会返回
   *  这部分内容,外加之后追加的所有内容)。 */
  stdout: string;
  stderr: string;
}

export function spawnBackgroundShell(
  command: string,
  cwd: string,
  opts: SpawnBackgroundOptions = {},
): Promise<SpawnBackgroundResult> {
  const id = `shell_${++counter}`;
  // 沙箱包裹:有 policy 走 launcher(darwin 上 sandbox-exec),
  // 无 policy 则 passthrough,等价旧的 `spawn(command, [], {shell:true})`。
  const launch = opts.sandbox
    ? getSandboxLauncher(opts.sandbox).buildSpawn(command, { cwd })
    : { file: command, args: [], shell: true };
  const child = spawn(launch.file, launch.args, {
    cwd,
    shell: launch.shell ?? false,
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...opts.env },
  });

  const entry: InternalShell = {
    id,
    command,
    cwd,
    pid: child.pid ?? null,
    startedAt: Date.now(),
    status: "running",
    exitCode: null,
    child,
    stdoutBuf: "",
    stderrBuf: "",
    readOffsetStdout: 0,
    readOffsetStderr: 0,
  };
  shells.set(id, entry);

  child.stdout?.on("data", (chunk) => {
    entry.stdoutBuf = appendCapped(entry.stdoutBuf, chunk.toString());
  });
  child.stderr?.on("data", (chunk) => {
    entry.stderrBuf = appendCapped(entry.stderrBuf, chunk.toString());
  });
  child.on("close", (code) => {
    entry.status = "exited";
    entry.exitCode = code ?? 0;
  });
  child.on("error", (err) => {
    entry.stderrBuf = appendCapped(
      entry.stderrBuf,
      `\n[shell error] ${err.message}\n`,
    );
    entry.status = "exited";
    entry.exitCode = entry.exitCode ?? 1;
  });

  const windowMs = opts.initialWindowMs ?? DEFAULT_INITIAL_WINDOW_MS;
  return new Promise((resolve) => {
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      // 此处不要推进读取偏移 —— 该快照是一份预览;agent 的首次
      // readShellOutput 调用仍会返回这部分内容(外加之后新追加的内容)。
      resolve({
        shellId: id,
        pid: entry.pid,
        status: entry.status,
        exitCode: entry.exitCode,
        stdout: entry.stdoutBuf,
        stderr: entry.stderrBuf,
      });
    };
    const timer = setTimeout(settle, windowMs);
    child.on("close", () => {
      clearTimeout(timer);
      settle();
    });
  });
}

export interface ReadShellResult {
  shellId: string;
  status: "running" | "exited";
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** 若因缓冲区上限丢弃了部分中间输出,则为 true。 */
  truncated?: boolean;
}

export function readShell(shellId: string): ReadShellResult | null {
  const e = shells.get(shellId);
  if (!e) return null;
  const droppedStdout = e.readOffsetStdout > e.stdoutBuf.length;
  const droppedStderr = e.readOffsetStderr > e.stderrBuf.length;
  if (droppedStdout) e.readOffsetStdout = 0;
  if (droppedStderr) e.readOffsetStderr = 0;
  const stdout = e.stdoutBuf.slice(e.readOffsetStdout);
  const stderr = e.stderrBuf.slice(e.readOffsetStderr);
  e.readOffsetStdout = e.stdoutBuf.length;
  e.readOffsetStderr = e.stderrBuf.length;
  return {
    shellId: e.id,
    status: e.status,
    exitCode: e.exitCode,
    stdout,
    stderr,
    truncated: droppedStdout || droppedStderr || undefined,
  };
}

export interface KillShellResult {
  shellId: string;
  killed: boolean;
  exitCode: number | null;
  /** 若不存在该 id 的 shell(已被清理),则为 false。 */
  found: boolean;
}

export function killShell(shellId: string): Promise<KillShellResult> {
  const e = shells.get(shellId);
  if (!e) {
    return Promise.resolve({
      shellId,
      killed: false,
      exitCode: null,
      found: false,
    });
  }
  if (e.status === "exited") {
    shells.delete(shellId);
    return Promise.resolve({
      shellId,
      killed: false,
      exitCode: e.exitCode,
      found: true,
    });
  }
  return new Promise((resolve) => {
    let resolved = false;
    const finish = (killed: boolean) => {
      if (resolved) return;
      resolved = true;
      shells.delete(shellId);
      resolve({ shellId, killed, exitCode: e.exitCode, found: true });
    };
    e.child.once("close", () => finish(true));
    terminate(e.child, "SIGTERM");
    setTimeout(() => {
      if (e.status === "running") terminate(e.child, "SIGKILL");
    }, 2000);
    // 硬超时,确保即使操作系统拒绝杀进程,调用方也不会永久挂起。
    setTimeout(() => finish(false), 5000);
  });
}

function terminate(child: ChildProcess, signal: NodeJS.Signals): void {
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
}

export function listShells(): ShellEntry[] {
  return Array.from(shells.values()).map(
    ({ id, command, cwd, pid, startedAt, status, exitCode }) => ({
      id,
      command,
      cwd,
      pid,
      startedAt,
      status,
      exitCode,
    }),
  );
}

export function killAllShells(): void {
  for (const id of Array.from(shells.keys())) {
    const e = shells.get(id);
    if (!e) continue;
    if (e.status === "running") terminate(e.child, "SIGKILL");
    shells.delete(id);
  }
}
