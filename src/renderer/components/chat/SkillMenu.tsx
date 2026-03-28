import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "../../lib/utils";

/** Shape returned by the `listSkills` IPC call. */
interface SkillMenuItem {
  id: string;
  name: string;
  description: string;
  source: string;
}

export interface SkillMenuProps {
  /** Current chat input value. */
  input: string;
  /** Called when the user picks a skill – replaces input with `/name `. */
  onSelect: (skillCommand: string) => void;
}

/**
 * Floating skill-picker that appears when the user types `/` at the start of
 * the chat input.  Fetches the skill list once via IPC, filters by the text
 * after `/`, and supports keyboard navigation (↑ / ↓ / Enter / Escape).
 */
export const SkillMenu = ({ input, onSelect }: SkillMenuProps) => {
  const [skills, setSkills] = useState<SkillMenuItem[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [fetched, setFetched] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Only show skill menu when typing the skill name, not after selecting one
  const isActive = input.startsWith("/") && !input.includes(" ");
  const query = isActive ? input.slice(1).toLowerCase() : "";

  // Fetch skills when the menu first opens
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
          console.log("[SkillMenu] Loaded skills:", list?.map(s => s.id) || []);
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

  // Filter skills by query
  const filtered = isActive
    ? skills.filter(
        (s) =>
          s.name.toLowerCase().includes(query) ||
          s.id.toLowerCase().includes(query) ||
          s.description.toLowerCase().includes(query),
      )
    : [];

  // Reset selection when the filtered list changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  // Handle keyboard navigation (attached to document so it works while textarea has focus)
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
        // Only intercept Enter when the menu is showing items
        e.preventDefault();
        e.stopPropagation();
        onSelect(`/${filtered[selectedIndex].id} `);
      } else if (e.key === "Escape") {
        // Let the parent handle clearing if needed
        onSelect("");
      }
    },
    [isActive, filtered, selectedIndex, onSelect],
  );

  useEffect(() => {
    if (!isActive) return;
    // Use capture phase so we can intercept before the textarea's Enter handler
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [isActive, handleKeyDown]);

  // Scroll selected item into view
  useEffect(() => {
    if (!menuRef.current) return;
    const item = menuRef.current.children[selectedIndex] as HTMLElement | undefined;
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
      {filtered.length === 0 ? (
        <div className="px-3 py-2 text-sm text-muted-foreground">
          {skills.length === 0
            ? "正在加载技能..."
            : query
              ? `未找到匹配 "${query}" 的技能`
              : "输入技能名称进行搜索"
          }
        </div>
      ) : (
        filtered.map((skill, i) => (
          <button
            key={skill.id}
            type="button"
            role="option"
            aria-selected={i === selectedIndex}
            className={cn(
              "flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors",
              i === selectedIndex
                ? "bg-accent text-accent-foreground"
                : "text-foreground hover:bg-accent/50",
            )}
            onMouseEnter={() => setSelectedIndex(i)}
            onClick={() => onSelect(`/${skill.id} `)}
          >
            <span className="font-medium">/{skill.id}</span>
            <span className="truncate text-muted-foreground">{skill.description}</span>
            <span className="ml-auto shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
              {skill.source}
            </span>
          </button>
        ))
      )}
    </div>
  );
};
