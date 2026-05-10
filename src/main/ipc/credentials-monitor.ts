/**
 * Credential health monitor (M7).
 *
 * Runs once per app launch (fire-and-forget from `main/index.ts`).
 * Re-tests every stored credential whose `lastTestedAt` is older than
 * 24h, persists `testStatus` + `lastTestError` so the CredentialsPanel
 * can show a status dot without blocking on a network round-trip.
 *
 * `gitlab_pat` credentials need a host. We use `lastTestedHost` if set
 * (populated by the user's first manual test via the GitLab connect
 * modal); otherwise we default to `gitlab.com`. Self-hosted users who
 * have never run a manual test will see "error" until they do — the
 * tradeoff matches the GIT_ASKPASS PR scope.
 */

import {
  type Credential,
  getCredentialToken,
  listCredentials,
  recordCredentialTest,
} from "../db";

const HEALTH_DEBOUNCE_MS = 24 * 60 * 60 * 1000; // 24 hours

interface TestResult {
  ok: boolean;
  error?: string;
}

const testGithubToken = async (token: string): Promise<TestResult> => {
  try {
    const res = await fetch("https://api.github.com/user", {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!res.ok) return { ok: false, error: `GitHub responded ${res.status}` };
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
};

const testGitlabToken = async (
  token: string,
  host: string,
): Promise<TestResult> => {
  try {
    const res = await fetch(`https://${host}/api/v4/user`, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
    });
    if (!res.ok) return { ok: false, error: `GitLab responded ${res.status}` };
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
};

/** Should this credential be re-tested now? */
export const isStale = (
  c: Pick<Credential, "lastTestedAt" | "testStatus">,
  now = Date.now(),
  debounceMs = HEALTH_DEBOUNCE_MS,
): boolean => {
  if (!c.lastTestedAt || c.testStatus === null) return true;
  const lastMs = Date.parse(c.lastTestedAt);
  if (Number.isNaN(lastMs)) return true;
  return now - lastMs >= debounceMs;
};

/**
 * Re-test every stale credential. Updates the `testStatus` columns via
 * `recordCredentialTest()`. Errors during a single credential are
 * isolated — the monitor never throws.
 */
export const batchTestCredentials = async (): Promise<{
  tested: number;
  skipped: number;
}> => {
  let tested = 0;
  let skipped = 0;
  const all = listCredentials();
  for (const c of all) {
    if (!isStale(c)) {
      skipped++;
      continue;
    }
    try {
      const token = getCredentialToken(c.id);
      const host = c.lastTestedHost ?? "gitlab.com";
      const result =
        c.kind === "github_pat"
          ? await testGithubToken(token)
          : await testGitlabToken(token, host);
      recordCredentialTest({
        id: c.id,
        status: result.ok ? "ok" : "error",
        error: result.ok ? null : (result.error ?? "Token invalid"),
      });
      tested++;
    } catch (err) {
      console.warn(
        `[credentials-monitor] failed to test ${c.id}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return { tested, skipped };
};

export const __test__ = { HEALTH_DEBOUNCE_MS };
