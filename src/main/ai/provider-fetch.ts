/**
 * Bootstrap-injected `fetch` for AI SDK providers.
 *
 * `index.ts` sets this to the per-request proxy-aware fetch (`proxy-fetch.ts`)
 * so model HTTP traffic resolves its proxy per-host via Electron's
 * `session.resolveProxy` (full PAC / Clash / Mihomo rule set) instead of the
 * one-shot global `EnvHttpProxyAgent`, which routes every host through the env
 * proxy read once at startup. That global path has been observed to buffer
 * streaming responses (a large tool-call input arriving as one burst after a
 * long silence); routing through the per-host fetch can take a non-buffering
 * path (e.g. DIRECT for the API host).
 *
 * Undefined until bootstrap runs — adapters then fall back to the SDK default
 * (Node global fetch), so model creation still works in tests / headless.
 */
let providerFetch: typeof fetch | undefined;

export function setProviderFetch(fn: typeof fetch): void {
  providerFetch = fn;
}

export function getProviderFetch(): typeof fetch | undefined {
  return providerFetch;
}
