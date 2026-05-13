/**
 * Per-request proxy resolution for main-process `fetch`.
 *
 * `proxy-bootstrap.ts` probes one URL at startup and applies the result
 * globally via `EnvHttpProxyAgent`. That works when the user's proxy
 * routes every host identically, but breaks under split routing —
 * Mihomo / Clash / corporate PAC where some hosts go via proxy and
 * others go DIRECT. The classic symptom is `gitlab.quguazhan.com`
 * (CN domain → DIRECT in geoip rules) returning `ECONNRESET` because
 * we forced it through a proxy that's not set up to handle it.
 *
 * This module wraps `fetch` with a per-request lookup: for each URL we
 * call Electron's `session.resolveProxy(url)` (which respects the full
 * OS / PAC rule set), pick `DIRECT` or a specific `ProxyAgent`, and
 * pass it as the request's `dispatcher`. Per-proxy `ProxyAgent`s are
 * memoized so we don't churn TLS state.
 *
 * The global `EnvHttpProxyAgent` stays installed for callers that
 * don't go through this wrapper — passing an explicit `dispatcher`
 * overrides the global one for that call.
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
   * Chromium-style proxy resolver — typically
   * `session.defaultSession.resolveProxy.bind(session.defaultSession)`.
   * Receives the full request URL (not just the host) so PAC rules
   * that key on path can apply.
   */
  resolveProxy: (url: string) => Promise<string>;
  /** Defaults to global `fetch`. Injected for tests. */
  baseFetch?: typeof fetch;
  /** Defaults to {@link parseChromeProxyList}. Injected for tests. */
  parseProxyList?: (raw: string) => string | null;
  /**
   * Defaults to a shared {@link Agent} for direct requests and to
   * {@link ProxyAgent} for proxied ones. Injected for tests so we
   * never open real sockets.
   */
  agentFactory?: (proxyUrl: string | null) => Dispatcher;
  /** Defaults to `console.warn` with `[proxy-fetch]` prefix. */
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
  // Use undici's userland `fetch` rather than Node's built-in. Node's
  // bundled undici constructs request handlers that lack newer methods
  // (e.g. `onRequestStart`) that the userland `ProxyAgent` validates —
  // mixing them throws `UND_ERR_INVALID_ARG: invalid onRequestStart`.
  // Same-package dispatch + handler keeps the contract aligned.
  const baseFetch = (deps.baseFetch ?? undiciFetch) as typeof fetch;
  const parse = deps.parseProxyList ?? parseChromeProxyList;
  const warn = deps.warn ?? ((msg) => console.warn(`[proxy-fetch] ${msg}`));
  const factory =
    deps.agentFactory ??
    ((proxyUrl) => (proxyUrl ? new ProxyAgent(proxyUrl) : new Agent()));

  // Cache dispatchers so we reuse pools across requests. Keyed by the
  // resolved proxy URL — `"DIRECT"` is its own sentinel key.
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
      // If the resolver throws (e.g. session destroyed during shutdown),
      // fall back to direct — better than failing the whole request.
      warn(
        `resolveProxy threw, falling back to direct: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      dispatcher = agentFor(null);
    }
    // Node's global fetch types omit `dispatcher`, but undici accepts it.
    return baseFetch(input, { ...init, dispatcher } as RequestInit);
  };

  return wrapped as typeof fetch;
};
