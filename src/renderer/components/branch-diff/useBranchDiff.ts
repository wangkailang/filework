import { useCallback, useEffect, useRef, useState } from "react";
import type { BranchDiff } from "../../../main/core/git-diff/types";

interface UseBranchDiffOptions {
  /** 工作区根目录的绝对路径。 */
  path?: string;
  /** 对比基线分支。可在面板中切换;每个 base 的结果独立缓存。 */
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
  // 进行中的拉取计数。我们始终在 finally 中递减(即使
  // 是过期的 generation),以防加载指示器卡住。
  const inflight = useRef(0);
  // 单调递增的 generation。每次 fetchNow() 在开始时捕获
  // 自己的值;在 resolve 时,若期间已发起更新的 generation,
  // 则丢弃这次的*结果写入*(加载状态改由 `inflight` 负责)。
  const generation = useRef(0);
  // 按 base 维度缓存结果:同一 path + currentBranch 下,切换不同
  // 对比基线各自缓存,来回切换命中缓存、不重复拉取。invalidator
  // 递增(工具写文件)会清空整张表,因为未提交改动影响所有 base。
  const cache = useRef<Map<string, { data: BranchDiff; at: number }>>(
    new Map(),
  );
  const keyFor = useCallback(
    (base: string) => `${path ?? ""}::${base}::${currentBranch ?? ""}`,
    [path, currentBranch],
  );

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
        // 无论是否过期都写入缓存:结果本身对该 base 仍然有效。
        cache.current.set(keyFor(baseBranch), { data: result, at: Date.now() });
        if (myGen !== generation.current) return; // 已过期 —— 有更新的拉取正在进行
        setData(result);
      } catch (err) {
        if (myGen !== generation.current) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        inflight.current = Math.max(0, inflight.current - 1);
        if (inflight.current === 0) setLoading(false);
      }
    },
    [path, baseBranch, keyFor],
  );

  // 缓存键的任一维度(path / base / currentBranch)变化,或 invalidator
  // 递增时触发:先把命中的缓存立即上屏(切 base 不闪空),再按 TTL
  // 决定是否重新拉取。
  const cacheKey = keyFor(baseBranch);
  const lastSeenInvalidator = useRef(invalidator);
  useEffect(() => {
    if (!path) return;
    const invalidatorChanged = invalidator !== lastSeenInvalidator.current;
    lastSeenInvalidator.current = invalidator;
    if (invalidatorChanged) cache.current.clear();
    const cached = cache.current.get(cacheKey);
    setData(cached?.data ?? null);
    setError(null);
    const age = cached ? Date.now() - cached.at : Number.POSITIVE_INFINITY;
    if (cached && age < ttlMs && !invalidatorChanged) return;
    void fetchNow(invalidatorChanged);
  }, [path, cacheKey, invalidator, ttlMs, fetchNow]);

  const refresh = useCallback(() => {
    cache.current.delete(cacheKey);
    void fetchNow(true);
  }, [fetchNow, cacheKey]);

  return { data, loading, error, refresh };
}
