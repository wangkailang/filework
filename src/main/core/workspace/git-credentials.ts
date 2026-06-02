/**
 * GIT_ASKPASS 管线 —— 使 PAT 不进入磁盘上的 git config。
 *
 * 若没有它,`buildAuthedRemote` 会把 token 作为远程 URL 的一部分直接
 * 写入 `.git/config`(以及 reflog)。任何有磁盘访问权限的人都能读到。
 * 改用 git 的 askpass 机制后,token 改放在进程环境变量里;磁盘上的
 * URL 只携带用户名。
 *
 * 流程:
 *   1. 应用就绪时,写入 `<userData>/internal/askpass.js`。
 *      该脚本只是 `console.log` 出 `process.env.FILEWORK_GIT_PASSWORD`。
 *   2. 对每次需要鉴权的 `git` 调用,工作区通过环境变量传入
 *      `GIT_ASKPASS=<script-path>` 和 `FILEWORK_GIT_PASSWORD=<token>`。
 *      远程 URL 只内嵌用户名
 *      (`https://x-access-token@github.com/owner/repo.git`)。
 *   3. Git 在需要密码时调用 askpass;脚本将 token 从环境变量流式
 *      输出到 stdout。token 绝不会落到缓存目录的 git config 磁盘上。
 */

import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const ASKPASS_SCRIPT = `#!/usr/bin/env node
// filework GIT_ASKPASS helper. Receives a single arg from git (e.g.
// "Password for 'https://x-access-token@github.com':"); ignores it
// and prints the password from FILEWORK_GIT_PASSWORD. The username
// must live in the URL itself ("https://<user>@host/...") so git
// only asks for the password.
const pwd = process.env.FILEWORK_GIT_PASSWORD;
if (!pwd) process.exit(2);
process.stdout.write(pwd);
`;

let cachedScriptPath: string | null = null;

/**
 * 将 askpass.js 写入 `internalDir` 并返回其绝对路径。
 * 幂等:后续调用返回缓存的路径而不重写。
 * 在 POSIX 上文件被标记为可执行(模式 0755);在 Windows 上
 * `node` 解释器通过 git 自带的 bash 调用,chmod 为空操作。
 */
export const ensureAskpassScript = async (
  internalDir: string,
): Promise<string> => {
  if (cachedScriptPath) return cachedScriptPath;
  await mkdir(internalDir, { recursive: true });
  const scriptPath = path.join(internalDir, "askpass.js");
  await writeFile(scriptPath, ASKPASS_SCRIPT, "utf8");
  if (process.platform !== "win32") {
    await chmod(scriptPath, 0o755);
  }
  cachedScriptPath = scriptPath;
  return scriptPath;
};

/** 重置内存中的缓存。供测试使用,使每个套件获得全新的路径。 */
export const __resetAskpassCacheForTests = (): void => {
  cachedScriptPath = null;
};

/**
 * 为通过 askpass 鉴权的 git 调用构建环境变量。
 *
 * 调用方职责:
 *   - 构造形如 `https://<username>@<host>/...` 的净化 URL,
 *     使 git 知道以哪个用户身份鉴权。
 *   - 在应用就绪时调用一次 `ensureAskpassScript()`,并把得到的
 *     路径作为 `askpassPath` 传入此处。
 */
export const buildAskpassEnv = (opts: {
  askpassPath: string;
  password: string;
  baseEnv?: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv => ({
  ...(opts.baseEnv ?? process.env),
  GIT_ASKPASS: opts.askpassPath,
  // 双保险:askpass 失败时不退回到 TTY 提示。
  GIT_TERMINAL_PROMPT: "0",
  // 供我们的 askpass.js 读取;加命名空间前缀以避免与用户可能在
  // 全局设置的任何变量冲突。
  FILEWORK_GIT_PASSWORD: opts.password,
});

/** 净化后的 GitHub 远程地址 —— 仅含用户名,无 token。 */
export const githubSanitizedRemote = (owner: string, repo: string): string =>
  `https://x-access-token@github.com/${owner}/${repo}.git`;

/** 净化后的 GitLab 远程地址 —— 仅含用户名,无 token。 */
export const gitlabSanitizedRemote = (
  host: string,
  namespace: string,
  project: string,
): string => `https://oauth2@${host}/${namespace}/${project}.git`;

/**
 * 从用户提供的 GitLab host 中剥离协议前缀和任何尾部斜杠。用户常
 * 从浏览器地址栏粘贴 `https://gitlab.example.com`;没有这一归一化,
 * 克隆 URL 会变成 `https://https://gitlab.example.com/...`,缓存目录
 * 布局会变成 `<cacheDir>/https:/gitlab.example.com/...`。在每个接受
 * host 字符串的边界都应用它:IPC handler(新鲜输入)和
 * `GitLabWorkspace.create`(重放来自旧版本的持久化 ref)。
 */
export const normalizeGitLabHost = (host: string): string =>
  host
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "");

export const __test__ = { ASKPASS_SCRIPT };
