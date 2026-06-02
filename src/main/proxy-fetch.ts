/**
 * 主进程 `fetch` 的逐请求代理解析。
 *
 * `proxy-bootstrap.ts` 在启动时探测一个 URL,并通过 `EnvHttpProxyAgent`
 * 将结果全局应用。当用户的代理对所有主机采用相同路由时它能工作,
 * 但在分流路由下会失效 —— 例如 Mihomo / Clash / 企业 PAC,其中部分
 * 主机走代理、其余走 DIRECT。典型症状是 `gitlab.quguazhan.com`
 * (CN 域名 → 在 geoip 规则中走 DIRECT)返回 `ECONNRESET`,因为
 * 我们强制让它经由一个并未配置处理它的代理。
 *
 * 本模块用逐请求查询包装 `fetch`:对每个 URL 调用 Electron 的
 * `session.resolveProxy(url)`(它遵循完整的操作系统 / PAC 规则集),
 * 选择 `DIRECT` 或特定的 `ProxyAgent`,并将其作为请求的 `dispatcher`
 * 传入。按代理维度的 `ProxyAgent` 会被记忆化,以避免反复重建 TLS 状态。
 *
 * 全局的 `EnvHttpProxyAgent` 仍为不经过本包装器的调用方保留 ——
 * 传入显式的 `dispatcher` 会针对该次调用覆盖全局的那个。
 */

import {
  Agent,
  type Dispatcher,
  ProxyAgent,
  fetch as undiciFetch,
} from "undici";

import { parseChromeProxyList } from "./proxy-bootstrap";

export interface ProxyAwareFetchDeps {
  /**
   * Chromium 风格的代理解析器 —— 通常为
   * `session.defaultSession.resolveProxy.bind(session.defaultSession)`。
   * 接收完整的请求 URL(而非仅主机名),以便基于路径匹配的 PAC
   * 规则得以生效。
   */
  resolveProxy: (url: string) => Promise<string>;
  /** 默认为全局 `fetch`。用于测试注入。 */
  baseFetch?: typeof fetch;
  /** 默认为 {@link parseChromeProxyList}。用于测试注入。 */
  parseProxyList?: (raw: string) => string | null;
  /**
   * 默认为:直连请求使用共享的 {@link Agent},代理请求使用
   * {@link ProxyAgent}。用于测试注入,使我们永不打开真实套接字。
   */
  agentFactory?: (proxyUrl: string | null) => Dispatcher;
  /** 默认为带 `[proxy-fetch]` 前缀的 `console.warn`。 */
  warn?: (msg: string) => void;
}

const urlOf = (input: RequestInfo | URL): string => {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
};

export const createProxyAwareFetch = (
  deps: ProxyAwareFetchDeps,
): typeof fetch => {
  // 使用 undici 的用户态 `fetch`,而非 Node 内置的。Node 捆绑的
  // undici 构造的请求处理器缺少用户态 `ProxyAgent` 会校验的较新方法
  // (例如 `onRequestStart`)—— 混用两者会抛出
  // `UND_ERR_INVALID_ARG: invalid onRequestStart`。
  // 同一个包内的 dispatch + handler 能保持契约一致。
  const baseFetch = (deps.baseFetch ?? undiciFetch) as typeof fetch;
  const parse = deps.parseProxyList ?? parseChromeProxyList;
  const warn = deps.warn ?? ((msg) => console.warn(`[proxy-fetch] ${msg}`));
  const factory =
    deps.agentFactory ??
    ((proxyUrl) => (proxyUrl ? new ProxyAgent(proxyUrl) : new Agent()));

  // 缓存 dispatcher 以便跨请求复用连接池。以解析出的代理 URL 为键 ——
  // `"DIRECT"` 作为其自身的哨兵键。
  const agents = new Map<string, Dispatcher>();
  const agentFor = (proxyUrl: string | null): Dispatcher => {
    const key = proxyUrl ?? "DIRECT";
    const cached = agents.get(key);
    if (cached) return cached;
    const fresh = factory(proxyUrl);
    agents.set(key, fresh);
    return fresh;
  };

  const wrapped = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    let dispatcher: Dispatcher;
    try {
      const raw = await deps.resolveProxy(urlOf(input));
      const proxyUrl = parse(raw);
      dispatcher = agentFor(proxyUrl);
    } catch (err) {
      // 若解析器抛出异常(例如关闭过程中 session 被销毁),
      // 则回退到直连 —— 总好过让整个请求失败。
      warn(
        `resolveProxy threw, falling back to direct: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      dispatcher = agentFor(null);
    }
    // Node 的全局 fetch 类型省略了 `dispatcher`,但 undici 接受它。
    return baseFetch(input, { ...init, dispatcher } as RequestInit);
  };

  return wrapped as typeof fetch;
};
