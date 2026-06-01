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
  /\b(?:api[_-]?key|secret|passwd|password|token)\b\s*[:=]\s*\S{8,}/i, // 赋值式
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
  let count = 0;
  let out = text;
  // 先盖厂商前缀 / 赋值式(整段匹配),再跑高熵候选——• 不在 [A-Za-z0-9_-] 内,不会重复命中。
  for (const re of SECRET_PATTERNS) {
    const g = re.flags.includes("g") ? re.flags : `${re.flags}g`;
    out = out.replace(new RegExp(re.source, g), (m) => {
      count++;
      return mask(m);
    });
  }
  const hasKeyword = SECRET_KEYWORD.test(out);
  out = out.replace(TOKEN_CANDIDATE, (tok) => {
    if (!isHighEntropyToken(tok)) return tok;
    if (hasKeyword || tok.length >= STANDALONE_TOKEN_LEN) {
      count++;
      return mask(tok);
    }
    return tok;
  });
  return { text: out, count };
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
