/**
 * Wire the main process up to whatever HTTP proxy the user already trusts.
 *
 * Electron's renderer reads the OS proxy automatically; the main process
 * Node.js `fetch` (undici-backed) does not. On macOS, double-clicked apps
 * also don't inherit the shell's `HTTPS_PROXY` env. Net result: every
 * provider handler that uses `fetch` (github / gitlab) and every
 * `spawn('git', ...)` clone bypasses the user's proxy and fails on hosts
 * that only resolve via the proxy.
 *
 * This module probes for a proxy at startup, seeds `process.env` so spawned
 * git children inherit it, and installs an `EnvHttpProxyAgent` as the
 * undici global dispatcher so all `fetch()` calls re-read the env on each
 * request (which also gives us NO_PROXY support for free).
 */

import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";

export interface ProxyBootstrapDeps {
  /**
   * Chromium-style proxy resolver. In production this is
   * `session.defaultSession.resolveProxy.bind(session.defaultSession)`.
   * Returns strings like `"DIRECT"`, `"PROXY 127.0.0.1:7890"`, or
   * `"SOCKS5 127.0.0.1:7891; DIRECT"`.
   */
  resolveProxy: (url: string) => Promise<string>;
  /** Defaults to `process.env`. Mutated in place when a proxy is found. */
  env?: NodeJS.ProcessEnv;
  /**
   * Defaults to undici's `setGlobalDispatcher`. Injected for tests so we
   * don't actually flip the global dispatcher under vitest.
   */
  setDispatcher?: (agent: EnvHttpProxyAgent) => void;
  /** Defaults to `console.log` with a `[proxy]` prefix. */
  log?: (msg: string) => void;
  /**
   * URL used for the system-proxy probe. Defaults to a github URL because
   * (a) it's representative of what we'll actually fetch and (b) most
   * proxy rule sets won't carve out a special path for it.
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
 * Parse Chromium's PAC-style output. Picks the first PROXY entry — SOCKS
 * is currently unsupported (undici doesn't speak it natively).
 *
 * Examples:
 *   "DIRECT"                            -> null
 *   "PROXY 127.0.0.1:7890"              -> "http://127.0.0.1:7890"
 *   "PROXY 127.0.0.1:7890; DIRECT"      -> "http://127.0.0.1:7890"
 *   "SOCKS5 127.0.0.1:7891; DIRECT"     -> null (unsupported)
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

  // Always install EnvHttpProxyAgent — it's a no-op when env has no proxy
  // vars, and it lets us seed env below without re-wiring fetch.
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
