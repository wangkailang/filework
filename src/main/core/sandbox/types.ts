/**
 * Shell 沙箱类型定义。
 *
 * 对齐 Codex / Claude Code 的两层模型:
 *  - SandboxMode / SandboxPolicy:沙箱"技术上能做什么"(OS 内核层)。
 *  - ApprovalPolicy:"何时打断用户"(审批层),与沙箱解耦。
 *
 * 实现全程纯 TypeScript —— 沙箱通过 fork 系统自带的 `sandbox-exec`
 * (macOS)/ `bwrap`(Linux)落地,不引入 native / Rust。
 */

/** 沙箱强度档位。 */
export type SandboxMode =
  /** 只读:命令不能写任何文件(除 /dev 等标准设备)。 */
  | "read-only"
  /** 仅 workspace 可写,默认禁网(贴近 Codex Auto 预设)。 */
  | "workspace-write"
  /** 完全放开:不包裹沙箱(等价旧的裸调用)。 */
  | "danger-full-access";

/** 一次命令执行的完整沙箱策略。 */
export interface SandboxPolicy {
  mode: SandboxMode;
  /**
   * 可写根目录,必须是 **realpath 解析后**的绝对路径
   * (macOS `/tmp` → `/private/tmp`、软链接 workspace 等)。
   * read-only / danger-full-access 下被忽略。
   */
  writableRoots: string[];
  /** 是否允许出网。workspace-write 默认 false。 */
  allowNetwork: boolean;
}

/** 设置层派生出的沙箱配置(不含按调用计算的 writableRoots)。 */
export interface SandboxConfig {
  mode: SandboxMode;
  allowNetwork: boolean;
}

/** 审批策略:决定何时弹窗打断用户。 */
export type ApprovalPolicy =
  /** 每条命令都问(沙箱关闭/无效时的安全兜底,≈ 旧行为)。 */
  | "untrusted"
  /** 仅当模型主动申请提权(escalatePermissions)时才问。 */
  | "on-request"
  /** 沙箱内失败后再问要不要无沙箱重跑。 */
  | "on-failure"
  /** 从不问。 */
  | "never";

/**
 * 把原始 shell 命令 + 策略翻译成实际要 spawn 的 file/args。
 * 不负责进程管理(终止、缓冲、超时由调用点保留)。
 */
export interface SandboxLauncher {
  buildSpawn(
    command: string,
    opts: { cwd: string },
  ): {
    file: string;
    args: string[];
    /** true 时走 shell 解释(passthrough 用,保持旧行为)。 */
    shell?: boolean;
  };
}
