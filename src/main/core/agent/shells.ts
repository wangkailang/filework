/**
 * Background shell registry for long-running commands.
 *
 * Mirrors Claude Code's `Bash(run_in_background=true)` / `BashOutput` /
 * `KillShell` triad: an agent that runs `pnpm dev` (or any server /
 * watcher) gets back a `shellId` immediately, then polls for
 * incremental output via `readShell` and tears the process down via
 * `killShell` when done.
 *
 * Buffers are capped per stream (1 MB stdout + 1 MB stderr). When the
 * cap is exceeded the oldest 256 KB is dropped — a long-running
 * server's stdout doesn't grow unbounded, but recent context is
 * always available.
 *
 * Lifecycle: shells outlive the agent task that spawned them
 * (intentional — `pnpm dev` stays up across many turns). They're
 * cleaned up on app `before-quit` via {@link killAllShells}.
 */

import { type ChildProcess, spawn } from "node:child_process";

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
  /** Per-stream read offset. Increases monotonically; callers see
   *  only output produced since the previous `readShell` call. */
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
  /** ms to capture initial output before returning. Default 2000.
   *  Returns sooner if the child exits. */
  initialWindowMs?: number;
  /** Env overrides layered on top of process.env. */
  env?: NodeJS.ProcessEnv;
}

export interface SpawnBackgroundResult {
  shellId: string;
  pid: number | null;
  status: "running" | "exited";
  exitCode: number | null;
  /** stdout captured during the initial window (not consumed —
   *  next readShell still returns it plus anything appended). */
  stdout: string;
  stderr: string;
}

export function spawnBackgroundShell(
  command: string,
  cwd: string,
  opts: SpawnBackgroundOptions = {},
): Promise<SpawnBackgroundResult> {
  const id = `shell_${++counter}`;
  const child = spawn(command, [], {
    cwd,
    shell: true,
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
      // Don't advance read offsets here — the snapshot is a preview;
      // the agent's first readShellOutput call still returns this
      // content (plus anything new appended since).
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
  /** True if some intermediate output was dropped due to the buffer cap. */
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
  /** False if no shell with that id exists (already cleaned up). */
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
    // Hard timeout so the caller never hangs if the OS won't kill it.
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
      // already gone
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
