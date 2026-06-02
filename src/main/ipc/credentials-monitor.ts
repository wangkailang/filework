/**
 * 凭证健康监控(M7)。
 *
 * 每次应用启动时运行一次(由 `main/index.ts` 以 fire-and-forget 方式触发)。
 * 重新测试每个 `lastTestedAt` 超过
 * 24 小时的已存储凭证,持久化 `testStatus` + `lastTestError`,使 CredentialsPanel
 * 无需阻塞在网络往返上即可显示状态点。
 *
 * `gitlab_pat` 凭证需要 host。若已设置则使用 `lastTestedHost`
 * (由用户首次通过 GitLab 连接弹窗手动测试时填充);
 * 否则默认使用 `gitlab.com`。从未手动测试过的自托管用户
 * 在测试前会一直看到 "error" —— 该取舍
 * 与 GIT_ASKPASS PR 的范围一致。
 */

import {
  type Credential,
  getCredentialToken,
  listCredentials,
  recordCredentialTest,
} from "../db";

const HEALTH_DEBOUNCE_MS = 24 * 60 * 60 * 1000; // 24 小时

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

/** 该凭证现在是否需要重新测试? */
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
 * 重新测试每个过期凭证。通过 `recordCredentialTest()` 更新
 * `testStatus` 列。单个凭证的错误会被
 * 隔离 —— 该监控器永远不会抛出异常。
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
