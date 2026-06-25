/**
 * 工作区抽象。
 *
 * Workspace 表示 Agent 工具可寻址的操作面。当前实现(`LocalWorkspace`)
 * 是磁盘上的一个目录;`GitHubWorkspace` / `GitLabWorkspace` 在其上扩展了
 * 克隆 + 认证,使 agent 可以通过 `runCommand` 针对已认证的远程驱动 git。
 *
 * 工具通过 `WorkspaceFS` 接收工作区相对路径。各实现强制施加沙箱 ——
 * 对任何解析后落在工作区根目录之外的绝对路径,`toRelative()` 必须
 * 抛出 `WorkspaceEscapeError`。
 */

export type WorkspaceKind = "local" | "github" | "gitlab" | "gitea";

export interface WorkspaceEntry {
  name: string;
  /** 工作区相对的 POSIX 风格路径。 */
  path: string;
  isDirectory: boolean;
  size: number;
  extension: string;
  modifiedAt: string;
}

export interface ReadFileOptions {
  encoding?: "utf-8" | "binary";
}

export interface ListOptions {
  recursive?: boolean;
  includeStats?: boolean;
}

export interface MkdirOptions {
  recursive?: boolean;
}

export interface RmOptions {
  recursive?: boolean;
}

export interface ExecOptions {
  /** 工作区相对的 cwd。默认为工作区根目录。 */
  cwd?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  /**
   * OS 沙箱策略。提供则把命令包进 sandbox-exec(darwin)等内核沙箱;
   * 不提供则裸调用(内部 git 等基础设施命令保持旧行为,需网络/凭据)。
   */
  sandbox?: import("../sandbox/types").SandboxPolicy;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** 当 stdout/stderr 为限制上下文而被截断(保留头部+尾部)时为 true。 */
  outputTruncated?: boolean;
}

export interface FileStat {
  size: number;
  mtime: Date;
  isDirectory: boolean;
}

/**
 * Workspace 向工具暴露的类文件系统操作面。路径均为工作区相对路径;
 * 各实现相对其根目录解析这些路径,并强制要求解析后的位置仍处于
 * 根目录之内。
 */
export interface WorkspaceFS {
  readFile(rel: string, opts?: ReadFileOptions): Promise<string | Uint8Array>;
  writeFile(rel: string, content: string | Uint8Array): Promise<void>;
  exists(rel: string): Promise<boolean>;
  stat(rel: string): Promise<FileStat>;
  list(rel: string, opts?: ListOptions): Promise<WorkspaceEntry[]>;
  mkdir(rel: string, opts?: MkdirOptions): Promise<void>;
  rm(rel: string, opts?: RmOptions): Promise<void>;
  rename(fromRel: string, toRel: string): Promise<void>;
  /** 将工作区相对路径解析为实现相关的绝对形式。 */
  resolve(rel: string): string;
  /**
   * 将绝对路径转换为其工作区相对形式。当路径解析后落在工作区
   * 根目录之外时,抛出 {@link WorkspaceEscapeError}。
   */
  toRelative(abs: string): Promise<string>;
}

export interface WorkspaceExec {
  run(command: string, opts?: ExecOptions): Promise<ExecResult>;
  runProcess(
    executable: string,
    args?: string[],
    opts?: ExecOptions,
  ): Promise<ExecResult>;
}

/**
 * git 支撑的工作区暴露的、宿主侧的窄接口辅助类。agent 永远看不到它 ——
 * 它通过 `WorkspaceExec.run()` 调用 `git` / `gh` / `glab` CLI 来驱动 git。
 * 宿主用它实现分支选择器之类的 UI 能力,此处复用已认证的克隆,
 * 比在渲染进程侧重新发起一次 `git fetch` 更省成本。
 */
export interface WorkspaceSCM {
  /** 当前检出分支的符号名。 */
  currentBranch(): Promise<string>;
  /**
   * 从 origin 拉取,然后将工作树切换到 `branch`。需要时创建本地跟踪
   * 分支。拒绝在脏工作树上操作 —— 调用方必须先提交或丢弃改动。
   * 返回之前的分支,以便 UI 提供「切回」能力。
   */
  checkoutBranch(input: {
    branch: string;
  }): Promise<{ branch: string; previousBranch: string }>;
}

export interface Workspace {
  /** 稳定标识符,例如 "local:/Users/kai/proj" 或 "github:org/repo@branch"。 */
  readonly id: string;
  readonly kind: WorkspaceKind;
  /** 实现相关的根目录(LocalWorkspace 为绝对路径)。 */
  readonly root: string;
  readonly fs: WorkspaceFS;
  readonly exec: WorkspaceExec;
  /** 存在于 git 支撑的工作区;LocalWorkspace 上不存在。仅宿主使用。 */
  readonly scm?: WorkspaceSCM;
}

/**
 * 当调用方试图在工作区之外操作时,由 `WorkspaceFS.toRelative()`
 *(以及任何拒绝沙箱外路径的工具)抛出。
 */
export class WorkspaceEscapeError extends Error {
  constructor(
    public readonly attemptedPath: string,
    public readonly workspaceRoot: string,
  ) {
    super(
      `Path "${attemptedPath}" is outside workspace root "${workspaceRoot}"`,
    );
    this.name = "WorkspaceEscapeError";
  }
}
