/**
 * head-watcher — watches `.git/HEAD` of an open workspace clone and
 * broadcasts branch changes to all renderers.
 *
 * Why: BranchSwitcher (renderer) drives its chip off `workspaceRef.ref`,
 * which only updated when the user picked a branch from its own
 * dropdown. Any other path that changed HEAD — chat agent running
 * `git checkout` via Bash, an external terminal, a script — left the
 * sidebar stale. This module makes `.git/HEAD` the single source of
 * truth: every workspace open registers a watcher, and the renderer
 * patches `workspaceRef.ref` whenever HEAD reports a different branch.
 *
 * Idempotent: re-entry for the same cloneDir is a no-op. fs.watch on
 * `.git/` (non-recursive) catches the atomic rename that git uses when
 * rewriting HEAD; we debounce ~150ms to coalesce the multi-event
 * cascade git emits on a single checkout.
 */
import { type FSWatcher, watch } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { BrowserWindow } from "electron";

type CleanupFn = () => void;

const watchers = new Map<string, CleanupFn>();

/**
 * Parse `.git/HEAD`. Returns null for detached HEAD (raw sha) — the
 * renderer can't meaningfully render that as a "branch" and we must
 * not persist the literal "detached" into `recent_workspaces.ref`,
 * which would brick next-launch restore (no such branch to checkout).
 */
const parseHead = (content: string): string | null => {
  const m = content.trim().match(/^ref:\s*refs\/heads\/(.+)$/);
  return m ? m[1] : null;
};

const readBranch = async (cloneDir: string): Promise<string | null> => {
  try {
    const buf = await readFile(path.join(cloneDir, ".git", "HEAD"), "utf8");
    return parseHead(buf);
  } catch {
    return null;
  }
};

const broadcast = (cloneDir: string, branch: string): void => {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send("workspace:branch-changed", { cloneDir, branch });
    }
  }
};

/**
 * Begin watching `cloneDir/.git/HEAD`. Safe to call repeatedly for the
 * same cloneDir — only the first call installs an fs.watch handle.
 * Non-fatal on any I/O error (the BranchSwitcher just stays in its
 * pre-watcher behavior of updating only on its own dropdown).
 */
export const startHeadWatcher = async (cloneDir: string): Promise<void> => {
  if (watchers.has(cloneDir)) return;

  const initial = await readBranch(cloneDir);
  if (initial === null) return;

  let debounce: NodeJS.Timeout | null = null;
  let lastBranch = initial;
  let watcher: FSWatcher;
  try {
    watcher = watch(path.join(cloneDir, ".git"), (_event, filename) => {
      if (filename !== "HEAD") return;
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(async () => {
        debounce = null;
        const next = await readBranch(cloneDir);
        if (!next || next === lastBranch) return;
        lastBranch = next;
        broadcast(cloneDir, next);
      }, 150);
    });
  } catch {
    return;
  }

  const cleanup: CleanupFn = () => {
    if (debounce) clearTimeout(debounce);
    debounce = null;
    try {
      watcher.close();
    } catch {
      // already closed
    }
  };
  watcher.on("error", () => stopHeadWatcher(cloneDir));
  watchers.set(cloneDir, cleanup);
};

export const stopHeadWatcher = (cloneDir: string): void => {
  const cleanup = watchers.get(cloneDir);
  if (!cleanup) return;
  watchers.delete(cloneDir);
  cleanup();
};

export const stopAllHeadWatchers = (): void => {
  for (const dir of [...watchers.keys()]) stopHeadWatcher(dir);
};

export const __test__ = { parseHead };
