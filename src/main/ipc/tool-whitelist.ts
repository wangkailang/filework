// 持久化的「危险工具白名单」。用户在审批卡里选择「始终允许某工具」,或在
// 设置面板里开启某工具时,工具名写入这里;`requestApproval` 命中即自动放行,
// 跨任务、跨会话持续生效(取代旧的「按任务、内存态」临时白名单)。
//
// 存储:复用 settings 表,key = WHITELIST_SETTING_KEY,value = JSON 字符串数组。
// 读写都走内存缓存,DB 调用用 try/catch 兜底——这样在 DB 尚未初始化(如单元
// 测试)时不会崩,只是退化为纯内存行为。

import { getSetting, setSetting } from "../db";

export const WHITELIST_SETTING_KEY = "dangerous_tools_whitelist";

// 已成功从 DB 读出后缓存;null 表示尚未加载(或加载失败,留待下次重试)。
let cache: Set<string> | null = null;

/** 读取白名单集合。DB 未就绪时返回一个临时空集合且不缓存,以便后续重试。 */
function load(): Set<string> {
  if (cache) return cache;
  try {
    const raw = getSetting(WHITELIST_SETTING_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    const set = new Set<string>(
      Array.isArray(parsed)
        ? parsed.filter((x): x is string => typeof x === "string")
        : [],
    );
    cache = set;
    return set;
  } catch {
    // DB 尚未 initDatabase(),或解析失败:返回临时空集合,不写入缓存。
    return new Set<string>();
  }
}

/** 把集合写回 DB。失败(DB 未就绪)时静默忽略,内存缓存仍然生效。 */
function persist(set: Set<string>): void {
  try {
    setSetting(WHITELIST_SETTING_KEY, JSON.stringify([...set]));
  } catch {
    // 忽略:DB 未就绪时不阻断流程。
  }
}

/** 该工具是否已被持久白名单收录(命中即自动放行)。 */
export function isToolPersistentlyWhitelisted(toolName: string): boolean {
  return load().has(toolName);
}

/** 返回当前白名单里的所有工具名。 */
export function listPersistentToolWhitelist(): string[] {
  return [...load()];
}

/** 把工具加入白名单(幂等)。 */
export function addPersistentToolWhitelist(toolName: string): void {
  const set = load();
  if (set.has(toolName)) return;
  set.add(toolName);
  cache = set;
  persist(set);
}

/** 把工具移出白名单(幂等)。 */
export function removePersistentToolWhitelist(toolName: string): void {
  const set = load();
  if (!set.has(toolName)) return;
  set.delete(toolName);
  cache = set;
  persist(set);
}

/** 设置某工具的白名单状态(true=加入,false=移除)。 */
export function setPersistentToolWhitelist(
  toolName: string,
  enabled: boolean,
): void {
  if (enabled) addPersistentToolWhitelist(toolName);
  else removePersistentToolWhitelist(toolName);
}

/** 测试辅助:清空内存缓存,强制下次重新从 DB 读取。 */
export function __resetToolWhitelistCacheForTests(): void {
  cache = null;
}
