/**
 * WorkspaceRef —— IPC 与持久化层面工作区的身份标识。
 *
 * 与 `Workspace` 不同:
 *   - `Workspace` 是工具实际操作的运行时对象(fs/exec/scm)。
 *   - `WorkspaceRef` 是唯一标明「哪个工作区」的*句柄*,可跨 IPC、磁盘
 *     以及(最终的)同步进行序列化而保持有效。
 *
 * 渲染进程状态和 `recent_workspaces` 行都持有 `WorkspaceRef`。
 * 工厂(`workspace-factory.ts`)在每次任务开始时据 ref 构建一个具体的 `Workspace`。
 */

export type WorkspaceRef =
  | { kind: "local"; path: string }
  | {
      kind: "github";
      owner: string;
      repo: string;
      ref: string;
      credentialId: string;
    }
  | {
      kind: "gitlab";
      /** 例如 "gitlab.com" 或 "gitlab.example.com"。不含协议、不含端口。 */
      host: string;
      /** 群组 / 子群组路径,无前导斜杠(例如 "group/subgroup")。 */
      namespace: string;
      /** 项目 slug(路径最后一段)。 */
      project: string;
      ref: string;
      credentialId: string;
    };

/**
 * 工作区 ref 的稳定标识符。作为 `workspaceKey()` 的输入用于 JSONL 会话分桶,
 * 同时作为侧边栏 / 日志的展示键。与凭据轮换无关 —— 为同一 ref 重新签发 PAT
 * 仍保持相同的 id 和相同的会话历史。
 */
export const workspaceRefId = (r: WorkspaceRef): string => {
  if (r.kind === "local") return `local:${r.path}`;
  if (r.kind === "github") return `github:${r.owner}/${r.repo}@${r.ref}`;
  return `gitlab:${r.host}:${r.namespace}/${r.project}@${r.ref}`;
};

/** 编码以写入 `recent_workspaces.metadata`(TEXT 列,JSON)。 */
export const encodeRef = (r: WorkspaceRef): string => JSON.stringify(r);

/**
 * 解析存储的 ref。当输入不是合法 JSON 或不匹配任何已知结构时返回 `null` ——
 * 此时调用方回退到旧版的 `path` 列。
 */
export const decodeRef = (
  s: string | null | undefined,
): WorkspaceRef | null => {
  if (!s) return null;
  try {
    const parsed = JSON.parse(s) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const obj = parsed as Record<string, unknown>;
    if (obj.kind === "local" && typeof obj.path === "string") {
      return { kind: "local", path: obj.path };
    }
    if (
      obj.kind === "github" &&
      typeof obj.owner === "string" &&
      typeof obj.repo === "string" &&
      typeof obj.ref === "string" &&
      typeof obj.credentialId === "string"
    ) {
      return {
        kind: "github",
        owner: obj.owner,
        repo: obj.repo,
        ref: obj.ref,
        credentialId: obj.credentialId,
      };
    }
    if (
      obj.kind === "gitlab" &&
      typeof obj.host === "string" &&
      typeof obj.namespace === "string" &&
      typeof obj.project === "string" &&
      typeof obj.ref === "string" &&
      typeof obj.credentialId === "string"
    ) {
      return {
        kind: "gitlab",
        host: obj.host,
        namespace: obj.namespace,
        project: obj.project,
        ref: obj.ref,
        credentialId: obj.credentialId,
      };
    }
    return null;
  } catch {
    return null;
  }
};

/** 供侧边栏 / 标题使用的可读标签。 */
export const workspaceRefLabel = (r: WorkspaceRef): string => {
  if (r.kind === "local") {
    const segments = r.path.split("/").filter(Boolean);
    return segments[segments.length - 1] ?? r.path;
  }
  if (r.kind === "github") {
    return `${r.owner}/${r.repo}@${r.ref}`;
  }
  // gitlab:除非主机不是 gitlab.com,否则从展示标签中省略主机
  return r.host === "gitlab.com"
    ? `${r.namespace}/${r.project}@${r.ref}`
    : `${r.host}/${r.namespace}/${r.project}@${r.ref}`;
};
