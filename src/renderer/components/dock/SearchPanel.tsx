// 右侧停靠区「搜索」面板:输入文件名词元,经 native 加速检索当前工作区,
// 命中点击后复用 `filework:open-file` 事件在预览标签打开。
import { FileText, Loader2, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useI18nContext } from "../../i18n/i18n-react";

interface SearchHit {
  name: string;
  relPath: string;
  size: number;
  mtimeMs: number;
  score: number;
}

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(1)} ${units[i]}`;
};

const joinPath = (root: string, rel: string): string =>
  root.endsWith("/") ? `${root}${rel}` : `${root}/${rel}`;

export const SearchPanel = ({
  workspaceRoot,
  active,
}: {
  workspaceRoot: string;
  /** 标签变为可见时聚焦输入框。 */
  active: boolean;
}) => {
  const { LL } = useI18nContext();
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (active) inputRef.current?.focus();
  }, [active]);

  // 输入防抖:停止输入 250ms 后才检索,避免逐字敲键都打一次 IPC。
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setHits(null);
      setTotal(0);
      setLoading(false);
      return;
    }
    setLoading(true);
    let cancelled = false;
    const timer = setTimeout(() => {
      window.filework
        .searchFiles(workspaceRoot, q, { limit: 100 })
        .then((res) => {
          if (cancelled) return;
          setHits(res.hits);
          setTotal(res.totalMatched);
        })
        .catch(() => {
          if (!cancelled) {
            setHits([]);
            setTotal(0);
          }
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, workspaceRoot]);

  const openHit = (rel: string) => {
    window.dispatchEvent(
      new CustomEvent("filework:open-file", {
        detail: { path: joinPath(workspaceRoot, rel) },
      }),
    );
  };

  return (
    <div className="flex h-full flex-col">
      <div className="border-border border-b p-2">
        <div className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-2">
          <Search className="size-3.5 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={LL.search_placeholder()}
            className="w-full bg-transparent py-1.5 text-sm outline-none placeholder:text-muted-foreground"
          />
          {loading && (
            <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
          )}
        </div>
        {hits != null && (
          <div className="mt-1.5 px-0.5 text-[11px] text-muted-foreground">
            {LL.search_showing({ shown: hits.length, total })}
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        {hits == null ? (
          <div className="p-4 text-sm text-muted-foreground">
            {LL.search_hint()}
          </div>
        ) : hits.length === 0 ? (
          <div className="p-4 text-sm text-muted-foreground">
            {LL.search_empty()}
          </div>
        ) : (
          <ul className="py-1">
            {hits.map((h) => (
              <li key={h.relPath}>
                <button
                  type="button"
                  onClick={() => openHit(h.relPath)}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-accent"
                  title={h.relPath}
                >
                  <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-foreground">
                      {h.name}
                    </span>
                    <span className="block truncate text-[11px] text-muted-foreground">
                      {h.relPath}
                    </span>
                  </span>
                  <span className="shrink-0 text-[11px] text-muted-foreground">
                    {formatBytes(h.size)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};
