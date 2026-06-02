import { createHash } from "node:crypto";

/**
 * 将工作区路径哈希为文件系统安全的目录名。
 *
 * 返回 UTF-8 路径 sha256 的前 16 个十六进制字符。
 * 与 PI 的约定保持一致,使未来同址部署的 SDK 能读取同一目录树。
 * 碰撞空间为 2^64 ≈ 1.8e19 —— 对任何现实的工作区数量都绰绰有余。
 *
 * 输入不做归一化 —— 不同的路径字符串("/foo" 与 "/foo/")
 * 会得到不同的哈希。调用方(聊天 IPC 处理器)是所传入规范路径的
 * 权威来源。
 */
export function workspaceKey(workspacePath: string): string {
  return createHash("sha256")
    .update(workspacePath, "utf8")
    .digest("hex")
    .slice(0, 16);
}
