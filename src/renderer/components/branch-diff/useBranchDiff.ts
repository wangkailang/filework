import { useCallback, useEffect, useRef, useState } from "react";
import type { BranchDiff } from "../../../main/core/git-diff/types";

interface UseBranchDiffOptions {
  /** Workspace root absolute path. */
  path?: string;
  baseBranch?: string;
  /**
   * Current checked-out branch. Threaded only as a cache key — the IPC
   * handler always reads HEAD from git itself. When the value changes
   * (eg after BranchSwitcher), the hook resets and refetches instead
   * of waiting for the TTL to expire.
   */
  currentBranch?: string | null;
  /** Cache window in ms — refetch when older. Default 30 s. */
  ttlMs?: number;
  /** Bump externally (eg on tool completion) to force a refetch. */
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
  const loadingRef = useRef(false);
  // Monotonically increasing generation. Each fetchNow() captures its
  // own value at start; on resolve we drop the result if a newer
  // generation has been issued in the meantime (eg path changed, or
  // refresh() was clicked mid-flight). Poor-man's AbortController for
  // IPC promises.
  const generation = useRef(0);

  const fetchNow = useCallback(
    async (force = false): Promise<void> => {
      if (!path) return;
      // Idle fetch + in-flight already → defer to the running call.
      // refresh() passes force=true to bypass and issue a fresh request,
      // invalidating the in-flight one via the generation token.
      if (!force && loadingRef.current) return;
      const myGen = ++generation.current;
      loadingRef.current = true;
      setLoading(true);
      setError(null);
      try {
        const result = await window.filework.getBranchDiff({
          path,
          baseBranch,
        });
        if (myGen !== generation.current) return; // stale — newer fetch in flight
        setData(result);
        fetchedAt.current = Date.now();
      } catch (err) {
        if (myGen !== generation.current) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (myGen === generation.current) {
          loadingRef.current = false;
          setLoading(false);
        }
      }
    },
    [path, baseBranch],
  );

  // Reset cache when any cache-key dimension changes (path, baseBranch,
  // or the live currentBranch). Without this, a BranchSwitcher checkout
  // would keep showing the prior branch's diff until the 30 s TTL.
  useEffect(() => {
    fetchedAt.current = 0;
    setData(null);
  }, [path, baseBranch, currentBranch]);

  useEffect(() => {
    if (!path) return;
    const age = Date.now() - fetchedAt.current;
    if (data && age < ttlMs && invalidator === 0) return;
    void fetchNow();
  }, [path, invalidator, ttlMs, data, fetchNow]);

  const refresh = useCallback(() => {
    fetchedAt.current = 0;
    void fetchNow(true);
  }, [fetchNow]);

  return { data, loading, error, refresh };
}
