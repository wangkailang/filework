/**
 * 为派生的 `git` 子进程逐次调用构建代理环境变量。
 *
 * `proxy-bootstrap.ts` 在启动时基于单次探测 URL 注入
 * `process.env.HTTPS_PROXY`,而每个 git 子进程通过
 * `buildAskpassEnv({ ...process.env, ... })` 继承该环境。在分流路由
 * 配置下(Mihomo / Clash / 企业 PAC),某些 host 走 DIRECT、其他
 * 走代理,这一次性探测会为任何 PAC 判定与探测不同的 host 强制选错
 * —— 典型如某个国内自建 GitLab 因 git 的 HTTPS 连接被喂进不会转发
 * 它的代理而卡在 `LibreSSL SSL_ERROR_SYSCALL`。
 *
 * `proxy-fetch.ts` 通过对每个请求调用 `session.resolveProxy(url)`
 * 解决了主进程 `fetch()` 上同一类 bug。本模块是 git 的对应实现:
 * 给定子进程将访问的实际远程 URL,为「该」host 解析代理,并据此
 * 覆盖继承来的环境变量。DIRECT 清除所有代理提示;
 * PROXY 将 HTTPS_PROXY/HTTP_PROXY 固定为解析出的值。
 */

import { parseChromeProxyList } from "../../proxy-bootstrap";

/** Chromium 风格的代理解析器 —— 与 `proxy-fetch.ts` 所消费的形态相同。 */
export type ProxyResolver = (url: string) => Promise<string>;

const PROXY_ENV_KEYS = [
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "https_proxy",
  "http_proxy",
  "ALL_PROXY",
  "all_proxy",
] as const;

/**
 * 为目标是 `remoteUrl` 的 git 子进程构建环境变量。
 *
 * - 当 `resolveProxy` 未定义(测试中,或解析器接入之前)时,
 *   原样返回 `baseEnv`。
 * - 当解析器对该 URL 判定为 DIRECT 时,清除所有代理提示,使子进程
 *   无法从被污染的 `process.env` 中拾取到代理。
 * - 当解析器返回 `PROXY host:port` 条目时,用该值覆盖
 *   HTTPS_PROXY/HTTP_PROXY。
 *
 * 解析器失败时回退到 `baseEnv`:用继承来的任何值尝试调用,好过
 * 静默丢弃请求。
 */
export const buildGitProxyEnv = async (
  baseEnv: NodeJS.ProcessEnv,
  remoteUrl: string,
  resolveProxy: ProxyResolver | undefined,
): Promise<NodeJS.ProcessEnv> => {
  if (!resolveProxy) return baseEnv;
  let proxyUrl: string | null;
  try {
    const raw = await resolveProxy(remoteUrl);
    proxyUrl = parseChromeProxyList(raw);
  } catch {
    return baseEnv;
  }
  const next: NodeJS.ProcessEnv = { ...baseEnv };
  for (const k of PROXY_ENV_KEYS) {
    delete next[k];
  }
  if (proxyUrl) {
    next.HTTPS_PROXY = proxyUrl;
    next.HTTP_PROXY = proxyUrl;
  }
  return next;
};
