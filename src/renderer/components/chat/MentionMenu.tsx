// composer 里键入 `@` 触发的文件引用菜单:native 文件名检索,选中后把
// 末尾的 `@query` 替换为 `@<相对路径> `。键盘可达(↑/↓/Enter)。
import { FileText } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useI18nContext } from "../../i18n/i18n-react";
import { cn } from "../../lib/utils";
import { Command, CommandEmpty, CommandItem, CommandList } from "../ui/command";

interface FileHit {
  name: string;
  relPath: string;
}

export interface MentionMenuProps {
  /** 当前 composer 输入值。 */
  input: string;
  /** 工作区根,用于 native 文件检索。 */
  workspaceRoot: string;
  /** 选中文件后回传替换后的完整输入。 */
  onReplace: (next: string) => void;
}

// 仅当末尾正在键入 `@token`(行首或空格后的 @,后接非空白)时激活。
const MENTION_RE = /(?:^|\s)@([^\s]*)$/;

export const MentionMenu = ({
  input,
  workspaceRoot,
  onReplace,
}: MentionMenuProps) => {
  const { LL } = useI18nContext();
  const [hits, setHits] = useState<FileHit[]>([]);
  const [index, setIndex] = useState(0);
  const menuRef = useRef<HTMLDivElement>(null);

  const match = input.match(MENTION_RE);
  const active = match != null;
  const query = match?.[1] ?? "";

  // 防抖文件名检索(空 query 即 `@` 时也返回若干文件)
  useEffect(() => {
    if (!active) {
      setHits([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      window.filework
        .searchFiles(workspaceRoot, query, { limit: 8 })
        .then((res) => {
          if (!cancelled) {
            setHits(
              res.hits.map((h) => ({ name: h.name, relPath: h.relPath })),
            );
            setIndex(0);
          }
        })
        .catch(() => {
          if (!cancelled) setHits([]);
        });
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [active, query, workspaceRoot]);

  const select = useCallback(
    (rel: string) => {
      if (!rel) return;
      onReplace(input.replace(/@[^\s]*$/, `@${rel} `));
    },
    [input, onReplace],
  );

  // 键盘导航:捕获阶段,抢在 textarea 的 Enter 之前
  const onKey = useCallback(
    (e: KeyboardEvent) => {
      if (!active || hits.length === 0) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setIndex((p) => (p + 1) % hits.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setIndex((p) => (p <= 0 ? hits.length - 1 : p - 1));
      } else if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        select(hits[index]?.relPath ?? "");
      }
    },
    [active, hits, index, select],
  );

  useEffect(() => {
    if (!active) return;
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [active, onKey]);

  useEffect(() => {
    const el = menuRef.current?.children[index] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [index]);

  if (!active) return null;

  return (
    <div
      ref={menuRef}
      className={cn(
        "absolute right-0 bottom-full left-0 z-50 mb-1",
        "max-h-56 overflow-y-auto rounded-lg border border-border bg-popover shadow-md",
      )}
      role="listbox"
    >
      <Command shouldFilter={false} className="rounded-none bg-transparent p-0">
        <CommandList className="max-h-56 p-0">
          <CommandEmpty className="px-3 py-2 text-left font-mono text-xs text-muted-foreground">
            {LL.mention_empty()}
          </CommandEmpty>
          {hits.map((h, i) => (
            <CommandItem
              key={h.relPath}
              role="option"
              aria-selected={i === index}
              value={`${h.name} ${h.relPath}`}
              className={cn(
                "gap-2 px-3 py-1.5",
                i === index
                  ? "bg-accent text-foreground"
                  : "text-foreground hover:bg-accent/50",
              )}
              onMouseEnter={() => setIndex(i)}
              onSelect={() => select(h.relPath)}
            >
              <FileText className="size-3.5 shrink-0 text-file-code" />
              <span className="font-mono text-xs">{h.name}</span>
              <span className="ml-auto truncate font-mono text-[10px] text-muted-foreground">
                {h.relPath}
              </span>
            </CommandItem>
          ))}
        </CommandList>
      </Command>
    </div>
  );
};
