/**
 * 由 bootstrap 注入、供 AI SDK provider 使用的 `fetch`。
 *
 * `index.ts` 会将其设为按请求感知代理的 fetch(`proxy-fetch.ts`),使得模型的
 * HTTP 流量通过 Electron 的 `session.resolveProxy` 按 host 解析代理(完整的
 * PAC / Clash / Mihomo 规则集),而非走一次性的全局 `EnvHttpProxyAgent` ——
 * 后者会让所有 host 都走启动时读取一次的环境变量代理。已观察到该全局路径会缓冲
 * 流式响应(长时间静默后,一大段工具调用输入一次性爆发到达);改走按 host 的
 * fetch 则可能命中非缓冲路径(例如对 API host 走 DIRECT 直连)。
 *
 * 在 bootstrap 运行前为 undefined —— 此时适配器回退到 SDK 默认值(Node 全局
 * fetch),因此在测试 / 无头环境下模型创建仍可正常工作。
 */
let providerFetch: typeof fetch | undefined;

export function setProviderFetch(fn: typeof fetch): void {
  providerFetch = fn;
}

export function getProviderFetch(): typeof fetch | undefined {
  return providerFetch;
}
