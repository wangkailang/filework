import { Loader2, ShieldAlert } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useI18nContext } from "../../i18n/i18n-react";
import { getToolLabels } from "../ai-elements/tool-labels";

// tool-labels 未覆盖的危险工具,在此兜底显示中文名。
const EXTRA_TOOL_LABELS: Record<string, string> = {
  clearDirectoryCache: "清理目录缓存",
};

/**
 * 危险工具白名单管理:列出所有需要审批的工具,每个一个「始终允许」开关。
 * 开启后该工具在所有任务中自动放行,等同于在审批卡里点「始终允许」。
 */
export function ToolWhitelistPanel() {
  const { LL } = useI18nContext();
  const [tools, setTools] = useState<string[]>([]);
  const [enabled, setEnabled] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const state = await window.filework.toolWhitelist.getState();
    setTools(state.tools);
    setEnabled(new Set(state.enabled));
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = async (tool: string) => {
    const next = !enabled.has(tool);
    // 乐观更新,失败也仅是开关状态,下次进入面板会重新拉取。
    setEnabled((prev) => {
      const s = new Set(prev);
      if (next) s.add(tool);
      else s.delete(tool);
      return s;
    });
    await window.filework.toolWhitelist.set(tool, next);
  };

  const labels = getToolLabels(LL);
  const labelFor = (t: string) => labels[t] ?? EXTRA_TOOL_LABELS[t] ?? t;

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-sm font-medium text-foreground">工具白名单</h3>
        <p className="mt-1 text-xs text-muted-foreground leading-relaxed">
          开启「始终允许」后,该工具在所有任务中会自动放行、不再逐次弹出确认。
          这等同于在审批卡里点「始终允许」。请仅对你信任的操作开启。
        </p>
      </div>

      <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2.5">
        <ShieldAlert className="mt-0.5 size-4 shrink-0 text-amber-500" />
        <p className="text-xs leading-relaxed text-foreground/80">
          删除、写入等操作不可撤销。加入白名单意味着放弃这些操作的逐次确认,
          请谨慎开启。随时可在此关闭以恢复确认。
        </p>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          加载中…
        </div>
      ) : (
        <div className="divide-y divide-border rounded-lg border border-border">
          {tools.map((tool) => {
            const on = enabled.has(tool);
            return (
              <label
                key={tool}
                className="flex cursor-pointer items-center gap-3 px-3 py-2.5 transition-colors hover:bg-muted/40"
              >
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => void toggle(tool)}
                  className="size-4 shrink-0 cursor-pointer accent-primary"
                />
                <div className="min-w-0">
                  <div className="text-sm text-foreground">
                    {labelFor(tool)}
                  </div>
                  <div className="font-mono text-[11px] text-muted-foreground">
                    {tool}
                  </div>
                </div>
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}
