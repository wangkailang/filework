/**
 * 将主进程接入用户已信任的 HTTP 代理。
 *
 * Electron 的渲染进程会自动读取操作系统代理;但主进程的
 * Node.js `fetch`(基于 undici)不会。在 macOS 上,双击启动的应用
 * 也不会继承 shell 的 `HTTPS_PROXY` 环境变量。最终结果:每个
 * 使用 `fetch` 的 provider 处理器(github / gitlab)以及每个
 * `spawn('git', ...)` 克隆操作都会绕过用户的代理,在只能经由代理
 * 解析的主机上失败。
 *
 * 本模块在启动时探测代理,写入 `process.env` 以便派生的 git 子进程
 * 继承,并将 `EnvHttpProxyAgent` 安装为 undici 的全局 dispatcher,
 * 使所有 `fetch()` 调用在每次请求时重新读取环境变量(也顺带免费
 * 获得 NO_PROXY 支持)。
 */

import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";

export interface ProxyBootstrapDeps {
  /**
   * Chromium 风格的代理解析器。生产环境中即
   * `session.defaultSession.resolveProxy.bind(session.defaultSession)`。
   * 返回形如 `"DIRECT"`、`"PROXY 127.0.0.1:7890"` 或
   * `"SOCKS5 127.0.0.1:7891; DIRECT"` 的字符串。
   */
  resolveProxy: (url: string) => Promise<string>;
  /** 默认为 `process.env`。找到代理时原地修改。 */
  env?: NodeJS.ProcessEnv;
  /**
   * 默认为 undici 的 `setGlobalDispatcher`。用于测试注入,使我们在
   * vitest 下不会真正切换全局 dispatcher。
   */
  setDispatcher?: (agent: EnvHttpProxyAgent) => void;
  /** 默认为带 `[proxy]` 前缀的 `console.log`。 */
  log?: (msg: string) => void;
  /**
   * 用于系统代理探测的 URL。默认使用 github URL,因为
   * (a) 它能代表我们实际会请求的内容,且 (b) 大多数代理规则集
   * 不会为它单独开辟特殊路径。
   */
  probeUrl?: string;
}

const DEFAULT_PROBE_URL = "https://api.github.com";
const DEFAULT_NO_PROXY = "localhost,127.0.0.1,::1";

const hasEnvProxy = (env: NodeJS.ProcessEnv): boolean =>
  Boolean(
    env.HTTPS_PROXY ||
      env.https_proxy ||
      env.HTTP_PROXY ||
      env.http_proxy ||
      env.ALL_PROXY ||
      env.all_proxy,
  );

/**
 * 解析 Chromium 的 PAC 风格输出。选取第一个 PROXY 条目 —— 当前
 * 不支持 SOCKS(undici 原生不支持它)。
 *
 * 示例:
 *   "DIRECT"                            -> null
 *   "PROXY 127.0.0.1:7890"              -> "http://127.0.0.1:7890"
 *   "PROXY 127.0.0.1:7890; DIRECT"      -> "http://127.0.0.1:7890"
 *   "SOCKS5 127.0.0.1:7891; DIRECT"     -> null (不支持)
 */
export const parseChromeProxyList = (raw: string): string | null => {
  for (const entry of raw.split(";").map((s) => s.trim())) {
    if (!entry || entry === "DIRECT") continue;
    const match = entry.match(/^PROXY\s+(\S+)$/i);
    if (match) return `http://${match[1]}`;
  }
  return null;
};

export const bootstrapProxy = async (
  deps: ProxyBootstrapDeps,
): Promise<{ source: "env" | "system" | "none"; proxyUrl: string | null }> => {
  const env = deps.env ?? process.env;
  const log = deps.log ?? ((msg) => console.log(`[proxy] ${msg}`));
  const apply = deps.setDispatcher ?? setGlobalDispatcher;
  const probeUrl = deps.probeUrl ?? DEFAULT_PROBE_URL;

  // 始终安装 EnvHttpProxyAgent —— 当环境变量中没有代理变量时它是空操作,
  // 且能让我们在下面写入环境变量而无需重新接线 fetch。
  apply(new EnvHttpProxyAgent());

  if (hasEnvProxy(env)) {
    const fromEnv = env.HTTPS_PROXY ?? env.HTTP_PROXY ?? env.ALL_PROXY ?? null;
    log(`using preset env proxy: ${fromEnv}`);
    return { source: "env", proxyUrl: fromEnv };
  }

  let raw: string;
  try {
    raw = await deps.resolveProxy(probeUrl);
  } catch (err) {
    log(
      `resolveProxy(${probeUrl}) threw: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { source: "none", proxyUrl: null };
  }

  const proxyUrl = parseChromeProxyList(raw);
  if (!proxyUrl) {
    log(`system proxy resolver returned "${raw}" — staying direct`);
    return { source: "none", proxyUrl: null };
  }

  env.HTTPS_PROXY = proxyUrl;
  env.HTTP_PROXY = proxyUrl;
  if (!env.NO_PROXY && !env.no_proxy) {
    env.NO_PROXY = DEFAULT_NO_PROXY;
  }
  log(`picked up system proxy: ${proxyUrl}`);
  return { source: "system", proxyUrl };
};
