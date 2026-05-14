/**
 * Per-invocation proxy env for spawned `git` children.
 *
 * `proxy-bootstrap.ts` seeds `process.env.HTTPS_PROXY` at startup based
 * on a single probe URL, and every git subprocess inherits that env via
 * `buildAskpassEnv({ ...process.env, ... })`. Under split-routing setups
 * (Mihomo / Clash / corporate PAC) where some hosts route DIRECT and
 * others via proxy, that one-shot probe forces the wrong choice for any
 * host whose PAC verdict differs from the probe — typically a CN
 * self-hosted GitLab blocked behind a `LibreSSL SSL_ERROR_SYSCALL`
 * because git's HTTPS connection gets fed into a proxy that won't relay
 * it.
 *
 * `proxy-fetch.ts` solved the same class of bug for main-process
 * `fetch()` by consulting `session.resolveProxy(url)` per request. This
 * module is the equivalent for git: given the actual remote URL the
 * child will hit, resolve the proxy for *that* host and override the
 * inherited env vars accordingly. DIRECT scrubs every proxy hint;
 * PROXY pins HTTPS_PROXY/HTTP_PROXY to the resolved value.
 */

import { parseChromeProxyList } from "../../proxy-bootstrap";

/** Chromium-style proxy resolver — same shape `proxy-fetch.ts` consumes. */
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
 * Build env for a git subprocess that targets `remoteUrl`.
 *
 * - When `resolveProxy` is undefined (tests, or before the resolver is
 *   wired), returns `baseEnv` unchanged.
 * - When the resolver says DIRECT for this URL, scrubs every proxy hint
 *   so the child can't pick one up from the polluted `process.env`.
 * - When the resolver returns a `PROXY host:port` entry, overrides
 *   HTTPS_PROXY/HTTP_PROXY with that value.
 *
 * Resolver failures fall back to `baseEnv`: better to attempt the call
 * with whatever was inherited than to silently drop the request.
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
