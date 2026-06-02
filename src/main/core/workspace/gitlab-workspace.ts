/**
 * GitLabWorkspace — 基于 GitLab 项目(gitlab.com 或自托管)临时本地克隆的
 * 工作区。
 *
 * 在结构与设计上与 `github-workspace.ts` 保持一致。主要区别:
 *   - 带认证的克隆 URL 使用 `oauth2:<token>@<host>/<namespace>/<project>.git`
 *     (GitLab 推荐的 token 认证用户名)。
 *   - 克隆目录布局包含 host(`<cacheDir>/<host>/<namespace>/<project>/`),
 *     这样不同 GitLab 实例上相同的 `<namespace>/<project>` 不会冲突。
 *
 * 克隆完成后,fs/exec 委托给内部的 `LocalWorkspace`。agent 通过
 * `runCommand` 针对已认证的克隆驱动 git(`git`、`glab`);每次
 * runCommand 都需用户批准,作为安全兜底。
 *
 * `scm` 暴露一个仅供宿主使用的分支选择器 —— `currentBranch` +
 * `checkoutBranch` —— 供渲染进程的切换分支 UI 使用。
 *
 * Token 处理:PAT 通过 `GIT_ASKPASS` 辅助脚本传递,绝不嵌入磁盘上的
 * 远程 URL。
 */

import { spawn } from "node:child_process";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { checkoutBranchTo, withCloneLock } from "./clone-cache";
import {
  buildAskpassEnv,
  gitlabSanitizedRemote,
  normalizeGitLabHost,
} from "./git-credentials";
import { buildGitProxyEnv, type ProxyResolver } from "./git-proxy-env";
import { startHeadWatcher } from "./head-watcher";
import { LocalWorkspace } from "./local-workspace";
import type {
  Workspace,
  WorkspaceExec,
  WorkspaceFS,
  WorkspaceKind,
  WorkspaceSCM,
} from "./types";
import { workspaceRefId } from "./workspace-ref";

export interface GitLabRef {
  kind: "gitlab";
  host: string;
  namespace: string;
  project: string;
  ref: string;
  credentialId: string;
}

export interface GitLabWorkspaceDeps {
  /** 返回 credential id 对应的解密后 PAT。缺失时抛出异常。 */
  resolveToken: (credentialId: string) => Promise<string>;
  /** 临时克隆的根目录,例如 `~/.filework/cache/gitlab`。 */
  cacheDir: string;
  /**
   * GIT_ASKPASS 辅助脚本的绝对路径。生产环境由
   * `git-credentials.ts:ensureAskpassScript()` 接入。详见
   * `github-workspace.ts:GitHubWorkspaceDeps.askpassPath`。
   */
  askpassPath?: string;
  /** 默认 1 小时。超过此时长后,GitLabWorkspace.create() 会刷新。 */
  freshnessTtlMs?: number;
  /** 在测试中覆盖 spawn 实现。 */
  spawnFn?: typeof spawn;
  /**
   * 按 host 的代理解析器(Chromium PAC 输出:"DIRECT" / "PROXY h:p")。
   * 由 `index.ts` 接入到 `session.defaultSession.resolveProxy`。设置后,
   * 每个涉及网络的 git 子进程都会获得一份新构建的 env,其中
   * HTTPS_PROXY 与实际远程 URL 的 PAC 判定结果匹配 ——
   * 修复分流路由场景下全局 env 代理对某些 host 失效的问题。
   * 未设置时回退到继承的 `process.env`。
   */
  resolveProxy?: ProxyResolver;
}

const authedEnv = (
  askpassPath: string | undefined,
  token: string,
): NodeJS.ProcessEnv | undefined =>
  askpassPath ? buildAskpassEnv({ askpassPath, password: token }) : undefined;

const DEFAULT_TTL_MS = 60 * 60 * 1000;
/**
 * 标记文件路径(*相对于克隆根目录*)。位于 `.git/` 内,因此绝不会出现在
 * `git status --porcelain` 中 —— 否则 `checkoutBranch` 使用的干净工作树
 * 检查会始终把刚克隆的工作区判为「脏」。与 `github-workspace.ts` 保持一致。
 */
const LAST_FETCH_FILE = ".git/filework-last-fetch";
/** 修复前位于工作树根目录的位置;首次遇到时移除。 */
const LEGACY_LAST_FETCH_FILE = ".last-fetch";

const runGit = async (
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; spawnFn?: typeof spawn } = {},
): Promise<{ stdout: string; stderr: string }> => {
  const sp = opts.spawnFn ?? spawn;
  return new Promise((resolve, reject) => {
    const child = sp("git", args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else
        reject(
          new Error(
            `git ${args[0]} exited with code ${code}: ${stderr.trim() || stdout.trim()}`,
          ),
        );
    });
  });
};

/**
 * 克隆目录布局:`<cacheDir>/<host>/<namespace>/<project>/`。每个项目
 * 一份克隆 —— 切换分支会改动同一个目录。包含 host,
 * 这样不同 GitLab 实例上相同的 `<namespace>/<project>` 不会冲突。
 */
const cloneDirFor = (cacheDir: string, ref: GitLabRef): string =>
  path.join(cacheDir, ref.host, ref.namespace, ref.project);

const isFresh = async (cloneDir: string, ttlMs: number): Promise<boolean> => {
  try {
    const st = await stat(path.join(cloneDir, LAST_FETCH_FILE));
    return Date.now() - st.mtimeMs < ttlMs;
  } catch {
    return false;
  }
};

const stamp = async (cloneDir: string): Promise<void> => {
  await writeFile(
    path.join(cloneDir, LAST_FETCH_FILE),
    new Date().toISOString(),
    "utf8",
  );
};

const cloneExists = async (cloneDir: string): Promise<boolean> => {
  try {
    const st = await stat(path.join(cloneDir, ".git"));
    return st.isDirectory();
  } catch {
    return false;
  }
};

/**
 * 为 `ref` 实体化克隆。每个项目一份克隆 —— `ref.ref`
 * 是初始分支(传给 `git clone -b`),不是目录路径的一部分。
 * 与 `github-workspace.ts:ensureClone` 保持一致;设计理由见该文件。
 */
export const ensureClone = async (
  ref: GitLabRef,
  deps: GitLabWorkspaceDeps,
): Promise<string> => {
  const cloneDir = cloneDirFor(deps.cacheDir, ref);
  return withCloneLock(cloneDir, async () => {
    const ttlMs = deps.freshnessTtlMs ?? DEFAULT_TTL_MS;
    const exists = await cloneExists(cloneDir);

    if (exists && (await isFresh(cloneDir, ttlMs))) {
      return cloneDir;
    }

    const token = await deps.resolveToken(ref.credentialId);
    const remote = gitlabSanitizedRemote(ref.host, ref.namespace, ref.project);
    const env = await buildGitProxyEnv(
      authedEnv(deps.askpassPath, token) ?? process.env,
      remote,
      deps.resolveProxy,
    );

    if (!exists) {
      await mkdir(path.dirname(cloneDir), { recursive: true });
      try {
        await runGit(
          [
            "clone",
            "--filter=blob:none",
            "--branch",
            ref.ref,
            remote,
            cloneDir,
          ],
          { spawnFn: deps.spawnFn, env },
        );
      } catch (err) {
        await rm(cloneDir, { recursive: true, force: true });
        throw err;
      }
    } else {
      // 陈旧刷新:重新净化远程 URL,拉取所有 ref。不执行
      // `reset --hard` —— 保留会话分支上未提交的改动。
      await runGit(["remote", "set-url", "origin", remote], {
        cwd: cloneDir,
        spawnFn: deps.spawnFn,
      });
      await runGit(["fetch", "origin"], {
        cwd: cloneDir,
        spawnFn: deps.spawnFn,
        env,
      });
    }

    // 删除迁移进 `.git/` 之前遗留在根目录的旧标记文件。
    // 理由见 github-workspace.ts:ensureClone。
    await rm(path.join(cloneDir, LEGACY_LAST_FETCH_FILE), { force: true });

    await stamp(cloneDir);
    return cloneDir;
  });
};

interface GitLabScmDeps {
  cloneDir: string;
  host: string;
  namespace: string;
  project: string;
  resolveToken: () => Promise<string>;
  askpassPath?: string;
  spawnFn?: typeof spawn;
  resolveProxy?: ProxyResolver;
}

/**
 * 仅供宿主使用的 SCM 辅助类。只暴露渲染进程需要的分支选择器能力 ——
 * 其他所有 git 操作都由 agent 通过 `runCommand` 驱动。
 */
class GitLabWorkspaceSCM implements WorkspaceSCM {
  constructor(private readonly deps: GitLabScmDeps) {}

  private get cwd(): string {
    return this.deps.cloneDir;
  }

  async currentBranch(): Promise<string> {
    const { stdout } = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: this.cwd,
      spawnFn: this.deps.spawnFn,
    });
    return stdout.trim();
  }

  async checkoutBranch(input: {
    branch: string;
  }): Promise<{ branch: string; previousBranch: string }> {
    return withCloneLock(this.cwd, async () => {
      const previousBranch = await this.currentBranch();
      if (previousBranch === input.branch) {
        return { branch: input.branch, previousBranch };
      }
      const token = await this.deps.resolveToken();
      const remote = gitlabSanitizedRemote(
        this.deps.host,
        this.deps.namespace,
        this.deps.project,
      );
      await runGit(["remote", "set-url", "origin", remote], {
        cwd: this.cwd,
        spawnFn: this.deps.spawnFn,
      });
      await runGit(["fetch", "origin"], {
        cwd: this.cwd,
        spawnFn: this.deps.spawnFn,
        env: await buildGitProxyEnv(
          authedEnv(this.deps.askpassPath, token) ?? process.env,
          remote,
          this.deps.resolveProxy,
        ),
      });
      await checkoutBranchTo(this.cwd, input.branch, this.deps.spawnFn);
      return { branch: input.branch, previousBranch };
    });
  }
}

export class GitLabWorkspace implements Workspace {
  readonly kind: WorkspaceKind = "gitlab";
  readonly id: string;
  readonly root: string;
  readonly fs: WorkspaceFS;
  readonly exec: WorkspaceExec;
  readonly scm: WorkspaceSCM;

  private constructor(
    ref: GitLabRef,
    cloneDir: string,
    local: LocalWorkspace,
    deps: GitLabWorkspaceDeps,
  ) {
    this.id = workspaceRefId(ref);
    this.root = cloneDir;
    this.fs = local.fs;
    this.exec = local.exec;
    this.scm = new GitLabWorkspaceSCM({
      cloneDir,
      host: ref.host,
      namespace: ref.namespace,
      project: ref.project,
      resolveToken: () => deps.resolveToken(ref.credentialId),
      askpassPath: deps.askpassPath,
      spawnFn: deps.spawnFn,
      resolveProxy: deps.resolveProxy,
    });
  }

  static async create(
    ref: GitLabRef,
    deps: GitLabWorkspaceDeps,
  ): Promise<GitLabWorkspace> {
    // 防御性归一化:修复前的版本持久化的 host 中内嵌了 `https://`,
    // 而 workspace-factory 会原样回放这些 ref。
    const cleanRef: GitLabRef = {
      ...ref,
      host: normalizeGitLabHost(ref.host),
    };
    const cloneDir = await ensureClone(cleanRef, deps);
    // 幂等 —— 每个 cloneDir 的首次调用安装 watcher;
    // 后续调用为空操作。内部会吞掉错误。
    void startHeadWatcher(cloneDir);
    const local = new LocalWorkspace(cloneDir, {
      id: workspaceRefId(cleanRef),
    });
    return new GitLabWorkspace(cleanRef, cloneDir, local, deps);
  }
}

export const __test__ = {
  cloneDirFor,
  isFresh,
  stamp,
};
