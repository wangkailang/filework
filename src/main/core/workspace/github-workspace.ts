/**
 * GitHubWorkspace —— 由 GitHub 仓库的临时本地克隆支撑的 Workspace。
 *
 * 布局:`<cacheDir>/<owner>/<repo>/` 持有
 * `https://github.com/<owner>/<repo>` 的单个部分克隆
 * (`--filter=blob:none` —— 所有 ref 可用,blob 按需获取)。切换分支
 * 通过 `git checkout` 改动这同一个目录,与本地 git 项目的心智模型
 * 一致。同级的 `.git/filework-last-fetch` 文件记录最近一次
 * `git fetch` 的时间戳,使新鲜度检查无需重新遍历工作树。
 *
 * 克隆物化后,fs/exec 委托给指向该克隆的内部 `LocalWorkspace` ——
 * 现有的工具注册表无需修改即可工作。agent 通过 `runCommand` 对已鉴权
 * 的克隆驱动 git(`git`、`gh`);每次 runCommand 的用户审批是安全网,
 * 取代了过去在服务端拦截写操作的类型化 SCM 工具。
 *
 * `scm` 暴露一个仅供宿主使用的分支选择器 —— `currentBranch` +
 * `checkoutBranch` —— 供渲染进程的切换分支 UI 使用。agent 自身从不
 * 触碰 `scm`;它通过 runCommand 执行 `git checkout`。
 *
 * Token 处理:PAT 流经 `GIT_ASKPASS` 辅助脚本,绝不内嵌到磁盘上的
 * 远程 URL 中。
 */

import { spawn } from "node:child_process";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { checkoutBranchTo, withCloneLock } from "./clone-cache";
import { buildAskpassEnv, githubSanitizedRemote } from "./git-credentials";
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

export interface GitHubRef {
  kind: "github";
  owner: string;
  repo: string;
  ref: string;
  credentialId: string;
}

export interface GitHubWorkspaceDeps {
  /** 返回该 credential id 对应的解密后 PAT。缺失时抛出异常。 */
  resolveToken: (credentialId: string) => Promise<string>;
  /** 临时克隆的根目录,例如 `~/.filework/cache/github`。 */
  cacheDir: string;
  /**
   * GIT_ASKPASS 辅助脚本的绝对路径。生产环境从
   * `git-credentials.ts:ensureAskpassScript()` 接入。测试中可留作
   * undefined —— `runGit` 会退回到不设置环境变量的普通 spawn,这没
   * 问题,因为 `git` 的测试桩从不真正鉴权。
   */
  askpassPath?: string;
  /**
   * 克隆新鲜度窗口,单位毫秒。距上次 `git fetch` 超过这段时间后,
   * GitHubWorkspace.create() 会在返回前刷新。默认 1 小时。
   */
  freshnessTtlMs?: number;
  /**
   * 在测试中覆盖 spawn 实现。生产代码使用默认的
   * `child_process.spawn`。
   */
  spawnFn?: typeof spawn;
  /**
   * 按 host 的代理解析器(Chromium PAC 输出:"DIRECT" / "PROXY h:p")。
   * 由 `index.ts` 接入到 `session.defaultSession.resolveProxy`。设置后,
   * 每个触网的 git 子进程都会获得一份全新构建的环境,其中
   * HTTPS_PROXY 匹配实际远程 URL 的 PAC 判定 —— 修复全局环境代理对
   * 某些 host 不正确的分流路由配置。未定义时回退到继承的
   * `process.env`。
   */
  resolveProxy?: ProxyResolver;
}

/**
 * 构建为已鉴权调用传给 `runGit` 的环境变量。当 askpass 未配置时返回
 * `undefined`(即继承 `process.env`)—— 在完全 mock spawn 的测试中
 * 很有用。
 */
const authedEnv = (
  askpassPath: string | undefined,
  token: string,
): NodeJS.ProcessEnv | undefined =>
  askpassPath ? buildAskpassEnv({ askpassPath, password: token }) : undefined;

const DEFAULT_TTL_MS = 60 * 60 * 1000;
/**
 * 时间戳文件路径(*相对于克隆根目录*)。存放在 `.git/` 内,因此绝不
 * 会出现在 `git status --porcelain` 中 —— 否则 `checkoutBranch` 使用的
 * 干净工作树检查会始终把刚克隆的工作区判定为「脏」。
 */
const LAST_FETCH_FILE = ".git/filework-last-fetch";
/** 修复前位于工作树根目录的位置;首次遇到时移除。 */
const LEGACY_LAST_FETCH_FILE = ".last-fetch";

/** 运行 git 子进程并捕获 stdout/stderr。非零退出时抛出异常。 */
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
 * 每个 `(owner, repo)` 一个克隆 —— 分支是工作树状态,而非路径组件。
 */
const cloneDirFor = (cacheDir: string, ref: GitHubRef): string =>
  path.join(cacheDir, ref.owner, ref.repo);

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
 * 在 `cloneDir` 处为 `ref` 物化克隆。每仓库一个克隆 ——
 * `ref.ref` 是*初始分支*(供 `git clone -b` 使用),不是目录路径的
 * 一部分。
 *
 *   - 尚无克隆 → `git clone -b <ref.ref> --filter=blob:none`。
 *     部分克隆:所有 ref 可见(无 `--single-branch`),blob 按需
 *     获取。工作树落在 `ref.ref` 上。
 *   - 克隆已存在 + 过期 → `git fetch origin`(更新所有远程跟踪
 *     ref;*不*触碰工作树,因此未提交的 agent 工作或非默认分支
 *     得以保留)。
 *   - 克隆已存在 + 新鲜 → 空操作。
 *
 * 初始克隆之后的分支切换是显式的用户操作 —— 见 `checkoutBranch`。
 * ensureClone 绝不自动切换。
 *
 * 并发:包裹在 `withCloneLock(cloneDir)` 中,使同一工作区的并发
 * 创建者排队,而非在文件系统状态上竞争。
 *
 * 鉴权:远程 URL 被净化(无 token),token 通过 GIT_ASKPASS 环境
 * 变量传入。刷新路径会重写远程 URL,以清除任何 M7 之前的 token
 * 泄漏。
 */
export const ensureClone = async (
  ref: GitHubRef,
  deps: GitHubWorkspaceDeps,
): Promise<string> => {
  const cloneDir = cloneDirFor(deps.cacheDir, ref);
  return withCloneLock(cloneDir, async () => {
    const ttlMs = deps.freshnessTtlMs ?? DEFAULT_TTL_MS;
    const exists = await cloneExists(cloneDir);

    if (exists && (await isFresh(cloneDir, ttlMs))) {
      return cloneDir;
    }

    const token = await deps.resolveToken(ref.credentialId);
    const remote = githubSanitizedRemote(ref.owner, ref.repo);
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
      // 过期刷新:重新净化远程(覆盖 .git/config 仍内嵌 token 的
      // M7 之前的克隆),然后获取每个 ref。不做 `reset --hard` ——
      // 工作树携带着我们不能覆盖的会话分支。
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

    // 删除在时间戳文件移入 `.git/` 之前任何位于根目录的旧时间戳
    // 文件。否则 `git status --porcelain` 会把它报告为 `??`,使每个
    // 克隆在 `checkoutBranch` 看来都是「脏」的。
    await rm(path.join(cloneDir, LEGACY_LAST_FETCH_FILE), { force: true });

    await stamp(cloneDir);
    return cloneDir;
  });
};

interface GitHubScmDeps {
  cloneDir: string;
  owner: string;
  repo: string;
  resolveToken: () => Promise<string>;
  askpassPath?: string;
  spawnFn?: typeof spawn;
  resolveProxy?: ProxyResolver;
}

/**
 * 面向 git 支撑工作区的、仅供宿主使用的 SCM 辅助类。只暴露渲染进程
 * 所需的分支选择器能力 —— agent 通过 `runCommand` 驱动其余所有 git
 * 操作。
 */
class GitHubWorkspaceSCM implements WorkspaceSCM {
  constructor(private readonly deps: GitHubScmDeps) {}

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
      const remote = githubSanitizedRemote(this.deps.owner, this.deps.repo);
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

export class GitHubWorkspace implements Workspace {
  readonly kind: WorkspaceKind = "github";
  readonly id: string;
  readonly root: string;
  readonly fs: WorkspaceFS;
  readonly exec: WorkspaceExec;
  readonly scm: WorkspaceSCM;

  private constructor(
    ref: GitHubRef,
    cloneDir: string,
    local: LocalWorkspace,
    deps: GitHubWorkspaceDeps,
  ) {
    this.id = workspaceRefId(ref);
    this.root = cloneDir;
    this.fs = local.fs;
    this.exec = local.exec;
    this.scm = new GitHubWorkspaceSCM({
      cloneDir,
      owner: ref.owner,
      repo: ref.repo,
      resolveToken: () => deps.resolveToken(ref.credentialId),
      askpassPath: deps.askpassPath,
      spawnFn: deps.spawnFn,
      resolveProxy: deps.resolveProxy,
    });
  }

  static async create(
    ref: GitHubRef,
    deps: GitHubWorkspaceDeps,
  ): Promise<GitHubWorkspace> {
    const cloneDir = await ensureClone(ref, deps);
    // 幂等 —— 每个 cloneDir 的首次调用安装 watcher;后续调用为空
    // 操作。错误在内部被吞掉。
    void startHeadWatcher(cloneDir);
    const local = new LocalWorkspace(cloneDir, { id: workspaceRefId(ref) });
    return new GitHubWorkspace(ref, cloneDir, local, deps);
  }
}

export const __test__ = {
  cloneDirFor,
  isFresh,
  stamp,
};
