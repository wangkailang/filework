/**
 * 在工具返回值的源头施加通用上限,作用于 ToolRegistry 边界,
 * 使得任何工具(内置、网络、MCP、未来新增)都无法在消费它的那一步
 * 把无界的大块数据塞进模型上下文。
 *
 * 这与逐步压缩(`compact-tool-results.ts`,在重发时收缩较旧的结果)互补:
 * 两者结合后,当前结果 ≤ 上限,较旧结果 ≤ 几 KB,因此无论使用何种工具,
 * 上下文都是有界的。
 *
 * 策略:递归地裁剪每个字符串字段(保留头部+尾部),并保留结果的结构/键,
 * 使模型仍能拿到一个可用的形态。对于病态的数组密集型结果
 * (例如成千上万个微小片段)作为最后手段:若序列化后整体仍超过硬上限,
 * 则退化为单个被截断的字符串。纯函数,无副作用。
 */

/** 单个字符串字段的上限。设得较宽松——只有失控的文本字段才会触及。 */
const DEFAULT_PER_STRING = 200_000;
/** 序列化结果的硬上限;最后手段——整块截断。 */
const DEFAULT_CEILING = 400_000;
const HEAD_FRAC = 0.75;

function truncString(s: string, cap: number): string {
  if (s.length <= cap) return s;
  const marker = (n: number) => `\n…[truncated ${n} chars]…\n`;
  // 为标记预留空间,使结果保持在 `cap` 之内。
  const budget = Math.max(0, cap - marker(s.length).length);
  const head = Math.floor(budget * HEAD_FRAC);
  const tail = budget - head;
  const dropped = s.length - head - tail;
  const out = `${s.slice(0, head)}${marker(dropped)}${s.slice(s.length - tail)}`;
  return out.length <= cap ? out : out.slice(0, cap);
}

/** 未发生裁剪时返回同一引用(避免不必要的分配)。 */
function clampStrings(value: unknown, perString: number): unknown {
  if (typeof value === "string") {
    return value.length > perString ? truncString(value, perString) : value;
  }
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((v) => {
      const c = clampStrings(v, perString);
      if (c !== v) changed = true;
      return c;
    });
    return changed ? out : value;
  }
  if (value && typeof value === "object") {
    let changed = false;
    const rec = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(rec)) {
      const c = clampStrings(rec[k], perString);
      if (c !== rec[k]) changed = true;
      out[k] = c;
    }
    return changed ? out : value;
  }
  return value;
}

export function capToolResult(
  result: unknown,
  opts?: { perString?: number; ceiling?: number },
): unknown {
  const perString = opts?.perString ?? DEFAULT_PER_STRING;
  const ceiling = opts?.ceiling ?? DEFAULT_CEILING;
  if (result == null) return result;
  if (typeof result !== "object" && typeof result !== "string") return result;

  const clamped = clampStrings(result, perString);
  if (typeof clamped === "string") return truncString(clamped, ceiling);

  // 最后手段的整体上限(覆盖 clampStrings 无法收缩的数组密集型结果)。
  try {
    const serialized = JSON.stringify(clamped);
    if (serialized != null && serialized.length > ceiling) {
      return truncString(serialized, ceiling);
    }
  } catch {
    // 循环引用 / 不可序列化——保留逐字段裁剪的结果。
  }
  return clamped;
}
