/**
 * 敏感信息(密钥/令牌)检测与掩码 —— 纯函数,无 node 依赖,主进程与 renderer 共用。
 *
 * 检测候选 token 用「提取最长的 [A-Za-z0-9_-] 串」而非按空白切词:中文里密钥常写成
 * `API密钥：tp-xxx`(全角冒号 + 汉字紧贴 token、无空格),按空白切会把整串粘成一个
 * 含汉字的 token 而漏检。正则提取在遇到 CJK / 全角标点 / `/.@` 等处自然终止,既根治
 * 粘连漏检,又让 URL / 路径(被 `/ . @` 切成短段)落不进高熵判定。
 */

/** 已知厂商前缀 / 赋值式(不带 g,供 test();掩码时按需补 g)。 */
const SECRET_PATTERNS: RegExp[] = [
  /sk-[a-z0-9]{16,}/i, // OpenAI / Anthropic 风格
  /\bgh[oprsu]_[A-Za-z0-9]{20,}/, // GitHub token
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /\bAIza[0-9A-Za-z\-_]{35}\b/, // Google API key
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/, // Slack
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, // 私钥
  /\b(?:api[_\- ]?key|secret|passwd|password|token)\b\s*[:=]\s*\S{8,}/i, // 赋值式(api key 允许空格)
];

/** 密钥类上下文关键词(中英)。 */
const SECRET_KEYWORD =
  /\b(?:api[_-]?key|access[_-]?key|secret|passwd|password|credential|token|bearer|auth|key)\b|密钥|秘钥|密匙|密码|口令|凭据|凭证|令牌|私钥/i;

/** 高熵候选 token:以字母数字开头的最长 [A-Za-z0-9_-] 串,长度 ≥16。 */
const TOKEN_CANDIDATE = /[A-Za-z0-9][A-Za-z0-9_-]{15,}/g;

/** 不含关键词时,独立高熵 token 触发的最小长度。 */
const STANDALONE_TOKEN_LEN = 32;

/**
 * 候选串是否像高熵凭据:含数字,且含 16 进制以外的字母(g-z)——借此排除纯 16 进制
 * 哈希(SHA)与 UUID(都只含 0-9a-f 与 -)。长度已由 TOKEN_CANDIDATE 保证 ≥16。
 */
function isHighEntropyToken(tok: string): boolean {
  if (!/[0-9]/.test(tok)) return false;
  if (!/[g-z]/i.test(tok)) return false;
  return true;
}

/** 掩码:保留首 2 + 末 2,中间固定 4 个圆点(不暴露真实长度)。过短则整体遮蔽。 */
function mask(tok: string): string {
  if (tok.length <= 8) return "••••";
  return `${tok.slice(0, 2)}••••${tok.slice(-2)}`;
}

/** 文本是否疑似含敏感凭据。 */
export function containsSecret(text: string): boolean {
  if (!text) return false;
  if (SECRET_PATTERNS.some((re) => re.test(text))) return true;
  const hasKeyword = SECRET_KEYWORD.test(text);
  for (const tok of text.match(TOKEN_CANDIDATE) ?? []) {
    if (!isHighEntropyToken(tok)) continue;
    if (hasKeyword || tok.length >= STANDALONE_TOKEN_LEN) return true;
  }
  return false;
}

/** 定位并掩码所有命中片段;返回脱敏文本与命中数。 */
export function redactSecrets(text: string): { text: string; count: number } {
  if (!text) return { text, count: 0 };
  const hasKeyword = SECRET_KEYWORD.test(text);
  // 在「原文」上收集所有命中区间 [start, end),再合并重叠区间——避免顺序遮蔽时
  // 后一个 pattern 命中前一个留下的掩码字符(•),造成同一密钥被重复计数/重复遮蔽。
  const spans: Array<[number, number]> = [];
  for (const re of SECRET_PATTERNS) {
    const g = new RegExp(
      re.source,
      re.flags.includes("g") ? re.flags : `${re.flags}g`,
    );
    for (let m = g.exec(text); m; m = g.exec(text)) {
      spans.push([m.index, m.index + m[0].length]);
      if (m[0].length === 0) g.lastIndex++; // 防零宽匹配死循环
    }
  }
  // 用独立实例 exec,避免污染模块级 TOKEN_CANDIDATE 的 lastIndex。
  const tc = new RegExp(TOKEN_CANDIDATE.source, "g");
  for (let m = tc.exec(text); m; m = tc.exec(text)) {
    const tok = m[0];
    if (!isHighEntropyToken(tok)) continue;
    if (hasKeyword || tok.length >= STANDALONE_TOKEN_LEN) {
      spans.push([m.index, m.index + tok.length]);
    }
  }
  if (spans.length === 0) return { text, count: 0 };
  spans.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const [s, e] of spans) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  // 从后往前替换,使前面区间的索引仍然有效。
  let out = text;
  for (let i = merged.length - 1; i >= 0; i--) {
    const [s, e] = merged[i];
    out = out.slice(0, s) + mask(out.slice(s, e)) + out.slice(e);
  }
  return { text: out, count: merged.length };
}

/** 递归掩码任意 JSON 值的字符串叶子(对象/数组/string);其它类型原样返回。 */
export function redactDeep(value: unknown): { value: unknown; count: number } {
  if (typeof value === "string") {
    const r = redactSecrets(value);
    return { value: r.text, count: r.count };
  }
  if (Array.isArray(value)) {
    let count = 0;
    const arr = value.map((v) => {
      const r = redactDeep(v);
      count += r.count;
      return r.value;
    });
    return { value: arr, count };
  }
  if (value && typeof value === "object") {
    let count = 0;
    const obj: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const r = redactDeep(v);
      count += r.count;
      obj[k] = r.value;
    }
    return { value: obj, count };
  }
  return { value, count: 0 };
}
