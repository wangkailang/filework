import { useCallback, useEffect, useRef, useState } from "react";
import type { BranchDiff } from "../../../main/core/git-diff/types";

interface UseBranchDiffOptions {
  /** Workspace root absolute path. */
  path?: string;
  baseBranch?: string;
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
  ttlMs = 30_000,
  invalidator = 0,
}: UseBranchDiffOptions): UseBranchDiffResult {
  const [data, setData] = useState<BranchDiff | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fetchedAt = useRef<number>(0);
  const inflight = useRef(false);

  const fetchNow = useCallback(async () => {
    if (!path || inflight.current) return;
    inflight.current = true;
    setLoading(true);
    setError(null);
    try {
      const result = await window.filework.getBranchDiff({ path, baseBranch });
      setData(result);
      fetchedAt.current = Date.now();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
      inflight.current = false;
    }
  }, [path, baseBranch]);

  useEffect(() => {
    if (!path) {
      setData(null);
      return;
    }
    const age = Date.now() - fetchedAt.current;
    if (data && age < ttlMs && invalidator === 0) return;
    void fetchNow();
  }, [path, baseBranch, invalidator, ttlMs, data, fetchNow]);

  const refresh = useCallback(() => {
    fetchedAt.current = 0;
    void fetchNow();
  }, [fetchNow]);

  return { data, loading, error, refresh };
}
