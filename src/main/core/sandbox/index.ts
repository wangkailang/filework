/**
 * 沙箱入口:按平台 + 策略选择 launcher,并提供策略派生辅助。
 *
 * Phase 1 后端:
 *  - darwin → Seatbelt(`sandbox-exec`)
 *  - 其它平台 / danger-full-access → passthrough(保持旧的裸 shell 行为)
 *
 * Linux 的 bwrap 后端为 Phase 4,届时在 `getSandboxLauncher` 增分支。
 */

import { realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildSeatbeltProfile } from "./seatbelt-profile";
import type {
  ApprovalPolicy,
  SandboxConfig,
  SandboxLauncher,
  SandboxMode,
  SandboxPolicy,
} from "./types";

export { buildSeatbeltProfile } from "./seatbelt-profile";
export type {
  ApprovalPolicy,
  SandboxConfig,
  SandboxLauncher,
  SandboxMode,
  SandboxPolicy,
} from "./types";

export const DEFAULT_SANDBOX_MODE: SandboxMode = "workspace-write";
export const DEFAULT_APPROVAL_POLICY: ApprovalPolicy = "on-request";

/** 把设置里的字符串解析成 ApprovalPolicy。未设置 → on-request。 */
export function resolveApprovalPolicy(raw: string | null): ApprovalPolicy {
  return raw === "untrusted" ||
    raw === "on-failure" ||
    raw === "never" ||
    raw === "on-request"
    ? raw
    : DEFAULT_APPROVAL_POLICY;
}

/** 不包裹沙箱、直接走系统 shell —— 等价于历史上的裸调用。 */
const passthroughLauncher: SandboxLauncher = {
  buildSpawn: (command) => ({ file: command, args: [], shell: true }),
};

/** darwin 上的 Seatbelt launcher。 */
function seatbeltLauncher(policy: SandboxPolicy): SandboxLauncher {
  const profile = buildSeatbeltProfile(policy);
  return {
    buildSpawn: (command) => ({
      file: "/usr/bin/sandbox-exec",
      args: ["-p", profile, "/bin/bash", "-c", command],
      shell: false,
    }),
  };
}

/**
 * 当前平台 + mode 下,OS 内核沙箱是否真正生效。
 * 用于审批层兜底:沙箱无效时即便策略宽松也必须弹窗。
 */
export function isSandboxEffective(mode: SandboxMode): boolean {
  return process.platform === "darwin" && mode !== "danger-full-access";
}

/** 按策略选 launcher。沙箱无效 / danger-full-access 时回落 passthrough。 */
export function getSandboxLauncher(policy: SandboxPolicy): SandboxLauncher {
  if (!isSandboxEffective(policy.mode)) return passthroughLauncher;
  return seatbeltLauncher(policy);
}

/**
 * 把设置里的字符串解析成 SandboxConfig。
 * 未设置 → 默认 workspace-write + 禁网(对齐 Codex Auto)。
 */
export function resolveSandboxConfig(raw: string | null): SandboxConfig {
  const mode: SandboxMode =
    raw === "read-only" || raw === "danger-full-access"
      ? raw
      : DEFAULT_SANDBOX_MODE;
  return { mode, allowNetwork: mode === "danger-full-access" };
}

/**
 * 计算一次执行的可写根:workspace 根 + 系统临时目录,均 realpath 解析
 * (macOS `/var` → `/private/var`、`$TMPDIR` 等),失败则退回 resolve。
 */
export async function resolveWritableRoots(
  workspaceRoot: string,
): Promise<string[]> {
  const out = new Set<string>();
  for (const p of [workspaceRoot, os.tmpdir()]) {
    try {
      out.add(await realpath(p));
    } catch {
      out.add(path.resolve(p));
    }
  }
  return [...out];
}
