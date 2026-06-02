import { useCallback, useEffect, useRef, useState } from "react";
import type { BranchDiff } from "../../../main/core/git-diff/types";

interface UseBranchDiffOptions {
  /** 工作区根目录的绝对路径。 */
  path?: string;
  baseBranch?: string;
  /**
   * 当前检出的分支。仅作为缓存键透传 —— IPC
   * 处理器始终自行从 git 读取 HEAD。当该值变化时
   * (例如在 BranchSwitcher 之后),hook 会重置并重新拉取,
   * 而不是等待 TTL 过期。
   */
  currentBranch?: string | null;
  /** 缓存窗口(毫秒) —— 超过则重新拉取。默认 30 秒。 */
  ttlMs?: number;
  /** 外部递增(例如工具完成时)以强制重新拉取。 */
  invalidator?: number;
}

interface UseBranchDiffResult {
  data: BranchDiff | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useBranchDiff({
  path,
  baseBranch = "main",
  currentBranch,
  ttlMs = 30_000,
  invalidator = 0,
}: UseBranchDiffOptions): UseBranchDiffResult {
  const [data, setData] = useState<BranchDiff | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fetchedAt = useRef<number>(0);
  // 进行中的拉取计数。我们始终在 finally 中递减(即使
  // 是过期的 generation),以防加载指示器卡住 —— 旧的有缺陷版本
  // 使用布尔值,在过期时跳过了重置,导致强制刷新后 loading
  // 一直卡在 true。
  const inflight = useRef(0);
  // 单调递增的 generation。每次 fetchNow() 在开始时捕获
  // 自己的值;在 resolve 时,若期间已发起更新的 generation,
  // 则丢弃这次的*结果写入*。加载状态
  // 改由 `inflight` 负责。
  const generation = useRef(0);

  const fetchNow = useCallback(
    async (force = false): Promise<void> => {
      if (!path) return;
      // 空闲拉取 + 已有请求运行中 → 让步给进行中的调用。
      // refresh() 传入 force=true 以绕过此限制并发起新请求。
      if (!force && inflight.current > 0) return;
      const myGen = ++generation.current;
      inflight.current += 1;
      setLoading(true);
      setError(null);
      try {
        const result = await window.filework.getBranchDiff({
          path,
          baseBranch,
        });
        if (myGen !== generation.current) return; // 已过期 —— 有更新的拉取正在进行
        setData(result);
        fetchedAt.current = Date.now();
      } catch (err) {
        if (myGen !== generation.current) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        inflight.current = Math.max(0, inflight.current - 1);
        if (inflight.current === 0) setLoading(false);
      }
    },
    [path, baseBranch],
  );

  // 当任一缓存键维度变化时(path、baseBranch
  // 或实时的 currentBranch)重置缓存。拼成单个字符串,
  // 使 effect 依赖数组保持精简,且 exhaustive-deps
  // 的 lint 规则不会因函数体未读取的值而报错。
  const cacheKey = `${path ?? ""}::${baseBranch}::${currentBranch ?? ""}`;
  const lastCacheKey = useRef(cacheKey);
  useEffect(() => {
    if (lastCacheKey.current === cacheKey) return;
    lastCacheKey.current = cacheKey;
    fetchedAt.current = 0;
    setData(null);
  }, [cacheKey]);

  // 记录我们上次处理过的 invalidator 值。`invalidator` 是一个
  // 单调计数器 —— 一旦递增就再也不会是 0,因此旧的
  // `invalidator === 0` 短路逻辑会永久破坏 TTL 快速路径,
  // 并使该 effect 变成无限的重新拉取循环。
  const lastSeenInvalidator = useRef(invalidator);

  useEffect(() => {
    if (!path) return;
    const age = Date.now() - fetchedAt.current;
    const invalidatorChanged = invalidator !== lastSeenInvalidator.current;
    lastSeenInvalidator.current = invalidator;
    if (data && age < ttlMs && !invalidatorChanged) return;
    void fetchNow();
  }, [path, invalidator, ttlMs, data, fetchNow]);

  const refresh = useCallback(() => {
    fetchedAt.current = 0;
    void fetchNow(true);
  }, [fetchNow]);

  return { data, loading, error, refresh };
}
