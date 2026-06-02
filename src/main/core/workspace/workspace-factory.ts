/**
 * 工作区工厂 —— 把 `WorkspaceRef` 转成运行时的 `Workspace`。
 *
 * 由 `ipc/ai-handlers.ts` 和 `ipc/chat-handlers.ts` 在需要为任务获取工作区时
 * 调用。按任务构建 Workspace 是有意为之:它保持 AgentLoop 边界清晰,并让
 * GitHubWorkspace 能在每个入口处重新校验克隆是否最新,而无需缓存失效的繁琐处理。
 */

import { existsSync } from "node:fs";
import path from "node:path";
import type { ProxyResolver } from "./git-proxy-env";
import { GitHubWorkspace } from "./github-workspace";
import { GitLabWorkspace } from "./gitlab-workspace";
import { startHeadWatcher } from "./head-watcher";
import { LocalWorkspace } from "./local-workspace";
import type { Workspace } from "./types";
import type { WorkspaceRef } from "./workspace-ref";

export interface WorkspaceFactoryDeps {
  /** 把存储的凭据 id 解密成底层 token。 */
  resolveToken: (credentialId: string) => Promise<string>;
  /** 临时 GitHub 克隆的根目录。 */
  githubCacheDir: string;
  /** 临时 GitLab 克隆的根目录。 */
  gitlabCacheDir: string;
  /**
   * GIT_ASKPASS 助手的绝对路径。由主进程引导通过
   * `git-credentials.ts:ensureAskpassScript()` 接入。省略时(例如
   * 测试中),git 调用回退为继承 `process.env`。
   */
  askpassPath?: string;
  /**
   * 为派生的 `git` 子进程提供的按主机代理解析器(见
   * `git-proxy-env.ts`)。由 `index.ts` 接入
   * `session.defaultSession.resolveProxy`。
   */
  resolveProxy?: ProxyResolver;
}

export const createWorkspace = async (
  ref: WorkspaceRef,
  deps: WorkspaceFactoryDeps,
): Promise<Workspace> => {
  if (ref.kind === "local") {
    // 幂等 —— 对非 git 目录是空操作(startHeadWatcher 在读不到
    // .git/HEAD 时提前返回)。让本地仓库获得与远程工作区相同的
    // 由聊天驱动的 checkout 同步能力。
    void startHeadWatcher(ref.path);
    return new LocalWorkspace(ref.path);
  }
  if (ref.kind === "github") {
    return GitHubWorkspace.create(ref, {
      resolveToken: deps.resolveToken,
      cacheDir: deps.githubCacheDir,
      askpassPath: deps.askpassPath,
      resolveProxy: deps.resolveProxy,
    });
  }
  if (ref.kind === "gitlab") {
    return GitLabWorkspace.create(ref, {
      resolveToken: deps.resolveToken,
      cacheDir: deps.gitlabCacheDir,
      askpassPath: deps.askpassPath,
      resolveProxy: deps.resolveProxy,
    });
  }
  const _exhaustive: never = ref;
  throw new Error(`Unsupported workspace kind: ${JSON.stringify(_exhaustive)}`);
};

/**
 * 当工作区由 git 支撑时返回 true —— 要么是远程克隆的 GitHub / GitLab
 * 工作区,要么是根目录含 `.git` 项的 LocalWorkspace。供提示词构建器据此
 * 决定是否注入 L1 git 原则块,也供 `buildAgentToolRegistry` 据此决定是否
 * 注入嵌在 `runCommand` description 中的 L2 协议。
 *
 * 使用同步的 `existsSync` 是有意为之:该检查每个任务只跑一次,针对的是
 * 主进程已经信任的 worktree 路径。改成异步检查会迫使调用方(系统提示词 +
 * 工具注册表构建)变成异步,却没有实际收益。
 *
 * `.git` 可能是文件(worktree / 子模块)而非目录,因此这里只测试是否存在,
 * 不判断是否为目录。
 */
export const isGitBackedWorkspace = (workspace: Workspace): boolean => {
  if (workspace.kind !== "local") return true;
  return existsSync(path.join(workspace.root, ".git"));
};
