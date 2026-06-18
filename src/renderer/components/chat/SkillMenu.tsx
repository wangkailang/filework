import { useCallback, useEffect, useRef, useState } from "react";
import { useI18nContext } from "../../i18n/i18n-react";
import { cn } from "../../lib/utils";
import { Command, CommandEmpty, CommandItem, CommandList } from "../ui/command";

/** `listSkills` IPC 调用返回的数据结构。 */
interface SkillMenuItem {
  id: string;
  name: string;
  description: string;
  source: string;
}

export interface SkillMenuProps {
  /** 当前聊天输入框的值。 */
  input: string;
  /** 用户选中某个技能时调用 —— 将输入替换为 `/name `。 */
  onSelect: (skillCommand: string) => void;
}

/**
 * 浮动的技能选择器,当用户在聊天输入框开头键入 `/` 时出现。
 * 通过 IPC 获取一次技能列表,按 `/` 之后的文本进行过滤,
 * 并支持键盘导航(↑ / ↓ / Enter / Escape)。
 */
export const SkillMenu = ({ input, onSelect }: SkillMenuProps) => {
  const { LL } = useI18nContext();
  const [skills, setSkills] = useState<SkillMenuItem[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [fetched, setFetched] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // 仅在键入技能名称时显示技能菜单,选中之后不再显示
  const isActive = input.startsWith("/") && !input.includes(" ");
  const query = isActive ? input.slice(1).toLowerCase() : "";

  // 菜单首次打开时获取技能列表
  useEffect(() => {
    if (!isActive) {
      setFetched(false);
      return;
    }
    if (fetched) return;

    let cancelled = false;
    window.filework
      .listSkills()
      .then((list: SkillMenuItem[]) => {
        if (!cancelled) {
          console.log(
            "[SkillMenu] Loaded skills:",
            list?.map((s) => s.id) || [],
          );
          setSkills(list ?? []);
          setFetched(true);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSkills([]);
          setFetched(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [isActive, fetched]);

  // 按查询词过滤技能
  const filtered = isActive
    ? skills.filter(
        (s) =>
          s.name.toLowerCase().includes(query) ||
          s.id.toLowerCase().includes(query) ||
          s.description.toLowerCase().includes(query),
      )
    : [];

  // 过滤后的列表变化时重置选中项
  useEffect(() => {
    setSelectedIndex(0);
  }, []);

  // 处理键盘导航(挂在 document 上,以便 textarea 获得焦点时仍能生效)
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!isActive) return;

      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((prev) => (prev + 1) % Math.max(filtered.length, 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((prev) =>
          prev <= 0 ? Math.max(filtered.length - 1, 0) : prev - 1,
        );
      } else if (e.key === "Enter" && filtered.length > 0) {
        // 仅在菜单展示有条目时拦截 Enter
        e.preventDefault();
        e.stopPropagation();
        onSelect(`/${filtered[selectedIndex].id} `);
      } else if (e.key === "Escape") {
        // 如有需要,交由父组件处理清空
        onSelect("");
      }
    },
    [isActive, filtered, selectedIndex, onSelect],
  );

  useEffect(() => {
    if (!isActive) return;
    // 使用捕获阶段,以便在 textarea 的 Enter 处理器之前拦截
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [isActive, handleKeyDown]);

  // 将选中项滚动到可视区域
  useEffect(() => {
    if (!menuRef.current) return;
    const item = menuRef.current.children[selectedIndex] as
      | HTMLElement
      | undefined;
    item?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  if (!isActive) return null;

  return (
    <div
      ref={menuRef}
      className={cn(
        "absolute bottom-full left-0 right-0 mb-1 z-50",
        "max-h-56 overflow-y-auto rounded-lg border border-border bg-popover shadow-md",
      )}
      role="listbox"
    >
      <Command shouldFilter={false} className="rounded-none bg-transparent p-0">
        <CommandList className="max-h-56 p-0">
          <CommandEmpty className="px-3 py-2 text-left text-sm text-muted-foreground">
            {skills.length === 0
              ? LL.skill_loading()
              : query
                ? LL.skill_notFound(query)
                : LL.skill_searchHint()}
          </CommandEmpty>
          {filtered.map((skill, i) => (
            <CommandItem
              key={skill.id}
              role="option"
              aria-selected={i === selectedIndex}
              value={`${skill.id} ${skill.name} ${skill.description}`}
              className={cn(
                "gap-2 px-3 py-2 text-sm",
                i === selectedIndex
                  ? "bg-accent text-accent-foreground"
                  : "text-foreground hover:bg-accent/50",
              )}
              onMouseEnter={() => setSelectedIndex(i)}
              onSelect={() => onSelect(`/${skill.id} `)}
            >
              <span className="font-medium">/{skill.id}</span>
              <span className="truncate text-muted-foreground">
                {skill.description}
              </span>
              <span className="ml-auto shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                {skill.source}
              </span>
            </CommandItem>
          ))}
        </CommandList>
      </Command>
    </div>
  );
};
