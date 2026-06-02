/**
 * head-watcher — 监听已打开工作区克隆的 `.git/HEAD`,
 * 并向所有渲染进程广播分支变更。
 *
 * 原因:BranchSwitcher(渲染进程)的标签基于 `workspaceRef.ref` 显示,
 * 而后者只在用户从其自身下拉框选择分支时才更新。任何其他改动 HEAD 的
 * 路径 —— 聊天 agent 通过 Bash 运行 `git checkout`、外部终端、脚本 ——
 * 都会让侧边栏停留在陈旧状态。本模块让 `.git/HEAD` 成为单一可信源:
 * 每次打开工作区都注册一个 watcher,只要 HEAD 报告了不同的分支,
 * 渲染进程就修正 `workspaceRef.ref`。
 *
 * 幂等:对同一 cloneDir 的重入为空操作。对 `.git/` 的 fs.watch
 * (非递归)能捕获 git 重写 HEAD 时使用的原子重命名;我们做约 150ms
 * 的防抖,以合并 git 在单次 checkout 中触发的多事件级联。
 */
import { type FSWatcher, watch } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { BrowserWindow } from "electron";

type CleanupFn = () => void;

const watchers = new Map<string, CleanupFn>();

/**
 * 解析 `.git/HEAD`。游离 HEAD(裸 sha)返回 null —— 渲染进程无法把它
 * 有意义地渲染为「分支」,而且我们不能把字面量 "detached" 持久化到
 * `recent_workspaces.ref`,否则会导致下次启动恢复失败(没有这样的分支
 * 可供 checkout)。
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
 * 开始监听 `cloneDir/.git/HEAD`。对同一 cloneDir 可重复调用 ——
 * 只有首次调用会安装 fs.watch 句柄。任何 I/O 错误都不致命
 * (BranchSwitcher 只是退回到 watcher 之前的行为,即仅在自身下拉框
 * 操作时更新)。
 */
export const startHeadWatcher = async (cloneDir: string): Promise<void> => {
  const initial = await readBranch(cloneDir);
  if (initial === null) return;

  // 初始对账:每次进入都广播磁盘上的分支,而不仅是首次注册时。
  // 渲染进程中的 `workspaceRef.ref` 从 `recent_workspaces` 恢复或由
  // 用户选择设定,在不同会话之间可能与 `.git/HEAD` 漂移(外部终端
  // checkout、切换中途崩溃等)。fs.watch 路径只在发生*变更*时触发 ——
  // 否则打开时陈旧的 ref.ref 将永远得不到修正,LLM 读到的分支会与
  // 标签不一致。
  //
  // 延迟执行,以便触发本流程的 IPC 处理器有时间返回、渲染进程的
  // setWorkspace 先运行;否则监听器会看到 `workspaceRef.current === null`
  // 而丢弃该消息。渲染进程的守卫 `if (curr.ref.ref === branch) return`
  // 使得 ref 与磁盘已一致时这是空操作。
  setTimeout(() => broadcast(cloneDir, initial), 150);

  if (watchers.has(cloneDir)) return;

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
      // 已经关闭
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
