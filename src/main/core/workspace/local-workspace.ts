/**
 * LocalWorkspace — workspace backed by a local filesystem directory.
 *
 * Sandboxing semantics: every relative path is resolved against the
 * workspace root and checked via `node:fs.realpath` so symlink escapes
 * are caught. `toRelative()` rejects absolute paths that resolve outside
 * the root with `WorkspaceEscapeError`. Logic mirrors the pre-M1 check
 * at `src/main/ipc/ai-tool-permissions.ts:27-59`, hoisted into the
 * workspace so all tools inherit it for free.
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

/**
 * Project the absolute path `p` into its canonical (symlink-resolved)
 * form, even when `p` does not exist yet. We walk up to the deepest
 * existing ancestor, realpath that, and rejoin the unresolved tail.
 *
 * On macOS this matters because `/tmp/x/y/z` and the realpath
 * `/private/var/folders/.../x/y/z` are different prefixes — comparing
 * the unresolved `joined` against a `realRoot` would always reject.
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
        // Reached filesystem root without resolving anything.
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

/** Resolve a path inside `root` and verify it does not escape after symlink resolution. */
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
        // skip inaccessible
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

  async run(command: string, opts?: ExecOptions): Promise<ExecResult> {
    let cwdAbs = this.root;
    if (opts?.cwd) {
      const candidate = path.isAbsolute(opts.cwd)
        ? opts.cwd
        : path.resolve(this.root, opts.cwd);
      const rel = await this.fs.toRelative(candidate);
      cwdAbs = this.fs.resolve(rel);
    }
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

      const child = spawn(command, [], {
        cwd: cwdAbs,
        shell: true,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
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
            // already gone
          }
        }
      };

      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (data) => {
        stdout += data.toString();
      });
      child.stderr?.on("data", (data) => {
        stderr += data.toString();
      });
      child.on("close", (code) => {
        settle({ stdout, stderr, exitCode: code ?? 0 });
      });
      child.on("error", (error) => settle(error, true));

      timeoutTimer = setTimeout(() => {
        if (settled) return;
        terminate("SIGTERM");
        killTimer = setTimeout(() => terminate("SIGKILL"), 2000);
        settle({
          stdout,
          stderr: `${stderr}\nCommand timed out after ${timeoutMs}ms`,
          exitCode: 124,
        });
      }, timeoutMs);

      const onAbort = () => {
        if (settled) return;
        terminate("SIGTERM");
        killTimer = setTimeout(() => terminate("SIGKILL"), 2000);
        settle({
          stdout,
          stderr: `${stderr}\nCommand was cancelled`,
          exitCode: 130,
        });
      };
      if (opts?.signal) {
        if (opts.signal.aborted) onAbort();
        else opts.signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }
}

export interface LocalWorkspaceOptions {
  /** Stable id for this workspace. Defaults to `local:<absolute-root>`. */
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
