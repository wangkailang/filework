/**
 * GIT_ASKPASS plumbing — keeps PATs out of the on-disk git config.
 *
 * Without this, `buildAuthedRemote` would write the token directly into
 * `.git/config` (and the reflog) as part of the remote URL. Anyone with
 * disk access could read it. Switching to git's askpass mechanism puts
 * the token in a process env var instead; the URL on disk only carries
 * the username.
 *
 * Flow:
 *   1. On app ready, write `<userData>/internal/askpass.js`.
 *      The script just `console.log`s `process.env.FILEWORK_GIT_PASSWORD`.
 *   2. For every `git` invocation that needs auth, the workspace passes
 *      `GIT_ASKPASS=<script-path>` and `FILEWORK_GIT_PASSWORD=<token>`
 *      via the env. The remote URL embeds only the username
 *      (`https://x-access-token@github.com/owner/repo.git`).
 *   3. Git invokes askpass when it needs the password; the script
 *      streams the token from env to stdout. The token never lands on
 *      disk in the cache dir's git config.
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
 * Write askpass.js to `internalDir` and return its absolute path.
 * Idempotent: subsequent calls return the cached path without rewriting.
 * On POSIX the file is marked executable (mode 0755); on Windows the
 * `node` interpreter is invoked through git's bundled bash and chmod
 * is a no-op.
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

/** Reset the in-memory cache. Used by tests so each suite gets a fresh path. */
export const __resetAskpassCacheForTests = (): void => {
  cachedScriptPath = null;
};

/**
 * Build env vars for a git invocation that authenticates via askpass.
 *
 * Caller responsibilities:
 *   - Construct a sanitized URL of the form `https://<username>@<host>/...`
 *     so git knows which user to authenticate as.
 *   - Call `ensureAskpassScript()` once on app ready and pass the
 *     resulting path here as `askpassPath`.
 */
export const buildAskpassEnv = (opts: {
  askpassPath: string;
  password: string;
  baseEnv?: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv => ({
  ...(opts.baseEnv ?? process.env),
  GIT_ASKPASS: opts.askpassPath,
  // Belt-and-braces: don't fall back to TTY prompt if askpass fails.
  GIT_TERMINAL_PROMPT: "0",
  // Our askpass.js reads this; namespaced to avoid colliding with
  // anything the user might set globally.
  FILEWORK_GIT_PASSWORD: opts.password,
});

/** Sanitized GitHub remote — username only, no token. */
export const githubSanitizedRemote = (owner: string, repo: string): string =>
  `https://x-access-token@github.com/${owner}/${repo}.git`;

/** Sanitized GitLab remote — username only, no token. */
export const gitlabSanitizedRemote = (
  host: string,
  namespace: string,
  project: string,
): string => `https://oauth2@${host}/${namespace}/${project}.git`;

/**
 * Strip the protocol prefix and any trailing slash from a user-supplied
 * GitLab host. Users often paste `https://gitlab.example.com` from a
 * browser URL bar; without this normalization the clone URL becomes
 * `https://https://gitlab.example.com/...` and the cache dir layout
 * becomes `<cacheDir>/https:/gitlab.example.com/...`. Apply at every
 * boundary that accepts a host string: the IPC handler (fresh input) and
 * `GitLabWorkspace.create` (replayed persisted refs from older versions).
 */
export const normalizeGitLabHost = (host: string): string =>
  host
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "");

export const __test__ = { ASKPASS_SCRIPT };
