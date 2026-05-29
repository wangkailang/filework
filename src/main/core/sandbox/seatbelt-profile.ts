/**
 * macOS Seatbelt(SBPL)profile 生成。
 *
 * 结构参考 Codex 的开源 profile:allow-most 打底,再 `deny file-write*`
 * 收紧写权限,最后用具体 `allow file-write*` 放开 workspace + 临时目录。
 * SBPL 语义是"最后匹配的规则生效",所以放开块必须排在 deny 之后。
 *
 * profile 经 `sandbox-exec -p '<profile>'` 内联传入,无需落临时文件。
 */

import type { SandboxPolicy } from "./types";

/** SBPL 字符串字面量转义(路径里极少出现,但仍需处理 `\` 和 `"`)。 */
function sbplString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** 始终允许写的标准设备(即便 read-only 也需要,否则常规命令都跑不起来)。 */
const DEVICE_LITERALS = [
  "/dev/null",
  "/dev/zero",
  "/dev/dtracehelper",
  "/dev/tty",
  "/dev/stdout",
  "/dev/stderr",
  "/dev/fd",
];

/**
 * 生成 Seatbelt profile 文本。
 *
 * @param policy writableRoots 必须已是 realpath 解析后的绝对路径。
 */
export function buildSeatbeltProfile(policy: SandboxPolicy): string {
  const lines: string[] = [
    "(version 1)",
    // 读、exec、读系统库等一律放开。
    "(allow default)",
    // 默认禁止一切写,随后按需放开。
    "(deny file-write*)",
  ];

  // 可写白名单:标准设备 + (workspace-write 时)各可写根。
  const writeRules: string[] = DEVICE_LITERALS.map(
    (p) => `  (literal "${sbplString(p)}")`,
  );
  if (policy.mode === "workspace-write") {
    for (const root of policy.writableRoots) {
      writeRules.push(`  (subpath "${sbplString(root)}")`);
    }
  }
  lines.push(`(allow file-write*\n${writeRules.join("\n")})`);

  // 网络:默认禁;allowNetwork 时不追加 deny(沿用 allow default)。
  if (!policy.allowNetwork) {
    lines.push("(deny network*)");
  }

  return `${lines.join("\n")}\n`;
}
