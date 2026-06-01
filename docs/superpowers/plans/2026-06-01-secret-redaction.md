# 密钥纯防御脱敏 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 密钥只要出现就检测,落盘/日志/记忆前一律掩码或拒绝,显示时即时掩码,并由确定性系统卡告知用户——把"是否泄漏"从 LLM 叙述变成系统事实。

**Architecture:** 一个跨进程共享的纯检测模块(`src/shared/security/secret-detection.ts`)提供 `containsSecret` / `redactSecrets` / `redactDeep`;一个 MessagePart 感知的脱敏助手(`src/shared/security/redact-message.ts`)被持久化层(`jsonl-store`)与渲染层(`ChatPanel`)共用。持久化收口处单点遮蔽;渲染时即时掩码并就地渲染系统卡(无新增 IPC)。

**Tech Stack:** TypeScript, Electron(main + renderer), React, Vitest。

**关键设计约束:**
- 检测器是**纯函数,无 node 依赖**,放 `src/shared/`(对标已有 `shared/mime.ts`,主进程与 renderer 都 value-import)。
- **持久化边界遮蔽**(非入口):in-memory 对话保留明文,当前轮 LLM 仍可应答;只在落盘/日志/显示边界脱敏。
- **memory 是特例**:durable store 连掩码版都不存,维持"命中即 reject"。
- **绝不盲目 deep-redact 图片/附件**的 base64 数据 → 按 part 类型选择性脱敏(只动 text/reasoning/error.message/tool.args/tool.result)。

---

## File Structure

```
新建  src/shared/security/secret-detection.ts            纯检测/掩码(无 node 依赖)
      src/shared/security/__tests__/secret-detection.test.ts
      src/shared/security/redact-message.ts              MessagePart 感知脱敏(共用)
      src/shared/security/__tests__/redact-message.test.ts
      src/renderer/components/chat/SystemNoticeCard.tsx  系统提示卡(纯展示)

改动  src/main/core/workspace/workspace-memory.ts         删除内置检测,re-import containsSecret
      src/main/core/session/jsonl-store.ts                saveMessages 落盘前脱敏
      src/main/core/__tests__/jsonl-store.test.ts         补落盘脱敏用例
      src/renderer/components/chat/ChatPanel.tsx          显示即时掩码 + 渲染系统卡
```

---

## Task 1: 共享检测模块 secret-detection.ts

**Files:**
- Create: `src/shared/security/secret-detection.ts`
- Test: `src/shared/security/__tests__/secret-detection.test.ts`

设计:检测不再用 `split(/\s+/)`(中文里 `API密钥:tp-xxx` 会被全角冒号/汉字粘连导致漏检),改为用正则**提取最长的 `[A-Za-z0-9_-]` 串**作为候选 token —— 提取在遇到 CJK / 全角标点时自然终止,根治粘连漏检。`containsSecret` 与 `redactSecrets` 共用同一套候选提取逻辑,保证"检测到的"与"被掩码的"一致。

- [ ] **Step 1: 写失败测试**

```ts
// src/shared/security/__tests__/secret-detection.test.ts
import { describe, expect, it } from "vitest";

import {
  containsSecret,
  redactDeep,
  redactSecrets,
} from "../secret-detection";

describe("secret-detection", () => {
  describe("containsSecret", () => {
    it("命中已知厂商前缀与赋值式", () => {
      expect(containsSecret("token is sk-abcdefghijklmnop1234")).toBe(true);
      expect(containsSecret("use ghp_0123456789abcdefghijABCDEFGHIJ12")).toBe(true);
      expect(containsSecret("password=hunter2hunter")).toBe(true);
      expect(containsSecret("-----BEGIN OPENSSH PRIVATE KEY-----")).toBe(true);
    });

    it("命中自然语言里的厂商 key(关键词 + 高熵 token)", () => {
      expect(
        containsSecret(
          "xiaomi llm key tp-sxnbvy8nfbqn8ocd7o974kbohq6s1hh3nmak6req8qeenm41 记一下",
        ),
      ).toBe(true);
      expect(containsSecret("我的密钥是 ab12cd34ef56gh78ij90kl12mn34")).toBe(true);
    });

    it("命中全角冒号紧贴、token 前无空格的中文写法(回归)", () => {
      expect(
        containsSecret(
          "小米LLM API密钥：tp-sxnbvy8nfbqn8ocd7o974kbohq6s1hh3nmak6req8qeenm41",
        ),
      ).toBe(true);
    });

    it("无关键词时,足够长的独立高熵 token 也命中", () => {
      expect(
        containsSecret("记住 tp-sxnbvy8nfbqn8ocd7o974kbohq6s1hh3nmak6"),
      ).toBe(true);
    });

    it("不误伤普通事实/路径/hash/uuid", () => {
      expect(containsSecret("uses pnpm and vitest")).toBe(false);
      expect(containsSecret("回复语言使用中文")).toBe(false);
      expect(containsSecret("项目根目录是 /Users/kailang/develop/2026/filework")).toBe(false);
      expect(containsSecret("build at commit a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0")).toBe(false);
      expect(containsSecret("session 550e8400-e29b-41d4-a716-446655440000")).toBe(false);
      expect(containsSecret("见 https://github.com/foo/bar 文档")).toBe(false);
    });
  });

  describe("redactSecrets", () => {
    it("掩码命中的 token,格式为首2+••••+末2,并返回 count", () => {
      const r = redactSecrets(
        "小米LLM API密钥：tp-sxnbvy8nfbqn8ocd7o974kbohq6s1hh3nmak6req8qeenm41",
      );
      expect(r.count).toBe(1);
      expect(r.text).toContain("tp••••41");
      expect(r.text).not.toContain("sxnbvy8");
    });

    it("ASCII 冒号 + 空格写法同样掩码", () => {
      const r = redactSecrets(
        "api key: tp-sxnbvy8nfbqn8ocd7o974kbohq6s1hh3nmak6req8qeenm41",
      );
      expect(r.count).toBe(1);
      expect(r.text).not.toContain("sxnbvy8");
    });

    it("无密钥文本原样返回,count=0", () => {
      const r = redactSecrets("项目使用 React 和 Electron");
      expect(r).toEqual({ text: "项目使用 React 和 Electron", count: 0 });
    });

    it("空串安全返回", () => {
      expect(redactSecrets("")).toEqual({ text: "", count: 0 });
    });
  });

  describe("redactDeep", () => {
    it("递归掩码对象/数组里的字符串叶子并累计 count", () => {
      const r = redactDeep({
        a: "api key: tp-sxnbvy8nfbqn8ocd7o974kbohq6s1hh3nmak6req8qeenm41",
        b: ["clean", "the secret token is sk-abcdefghijklmnop1234"],
        c: 42,
      });
      expect(r.count).toBe(2);
      const v = r.value as { a: string; b: string[]; c: number };
      expect(v.a).not.toContain("sxnbvy8");
      expect(v.b[0]).toBe("clean");
      expect(v.c).toBe(42);
    });

    it("非字符串原样返回 count=0", () => {
      expect(redactDeep(123)).toEqual({ value: 123, count: 0 });
      expect(redactDeep(null)).toEqual({ value: null, count: 0 });
    });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/shared/security/__tests__/secret-detection.test.ts`
Expected: FAIL（`Cannot find module '../secret-detection'`）

- [ ] **Step 3: 实现 secret-detection.ts**

```ts
// src/shared/security/secret-detection.ts
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
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/shared/security/__tests__/secret-detection.test.ts`
Expected: PASS（所有用例绿）

- [ ] **Step 5: 提交**

```bash
git add src/shared/security/secret-detection.ts src/shared/security/__tests__/secret-detection.test.ts
git commit -m "feat(security): 抽出共享密钥检测/掩码纯模块(正则提取候选 token,根治 CJK 粘连漏检)"
```

---

## Task 2: workspace-memory 改用共享检测

**Files:**
- Modify: `src/main/core/workspace/workspace-memory.ts`(删除内置检测块,行约 93-144;改为 re-import)
- Test:(沿用既有)`src/main/core/workspace/__tests__/workspace-memory.test.ts`

既有测试从 `workspace-memory` 导入 `containsSecret`,故此处必须 **re-export** 以保持 23 个用例不动。

- [ ] **Step 1: 先跑既有测试,确认基线全绿**

Run: `npx vitest run src/main/core/workspace/__tests__/workspace-memory.test.ts`
Expected: PASS（迁移前的基线）

- [ ] **Step 2: 删除 workspace-memory.ts 里的内置检测,改为 re-import**

删除该文件中从 `/** 敏感信息检测...` 注释起、到 `containsSecret` 函数结束(含 `SECRET_PATTERNS`、`SECRET_KEYWORD`、`SECRET_TOKEN_SPLIT`、`STANDALONE_TOKEN_LEN`、`looksLikeSecretToken`、`containsSecret`)的整段。`MemorySecretError` **保留**(memory 专用)。

在文件顶部 import 区加入并对外 re-export:

```ts
// 顶部 import 区(与其它 import 同组)
import { containsSecret } from "../../../shared/security/secret-detection";

// 紧随 import 之后,保持既有测试 `import { containsSecret } from ".../workspace-memory"` 可用
export { containsSecret };
```

`rememberMemory` 内对 `containsSecret(input.text)` 的调用保持不变。

- [ ] **Step 3: 运行测试确认仍全绿**

Run: `npx vitest run src/main/core/workspace/__tests__/workspace-memory.test.ts`
Expected: PASS（23 个用例不变,含全角冒号回归用例)

- [ ] **Step 4: 提交**

```bash
git add src/main/core/workspace/workspace-memory.ts
git commit -m "refactor(memory): containsSecret 改用共享检测模块,删除重复实现"
```

---

## Task 3: MessagePart 感知脱敏助手 redact-message.ts

**Files:**
- Create: `src/shared/security/redact-message.ts`
- Test: `src/shared/security/__tests__/redact-message.test.ts`

只对会承载明文的 part 字段脱敏(`text` / `reasoning.text` / `error.message` / `tool.args` / `tool.result`),**跳过 image/attachment 等二进制数据**,避免掩码损坏 base64。

- [ ] **Step 1: 写失败测试**

```ts
// src/shared/security/__tests__/redact-message.test.ts
import { describe, expect, it } from "vitest";

import type { MessagePart } from "../../../main/core/session/message-parts";
import { redactMessageParts } from "../redact-message";

const KEY = "tp-sxnbvy8nfbqn8ocd7o974kbohq6s1hh3nmak6req8qeenm41";

describe("redactMessageParts", () => {
  it("掩码 text part,并计数", () => {
    const parts: MessagePart[] = [{ type: "text", text: `api key: ${KEY}` }];
    const r = redactMessageParts(parts);
    expect(r.count).toBe(1);
    expect((r.parts[0] as { text: string }).text).not.toContain("sxnbvy8");
  });

  it("掩码 tool part 的 args 与 result", () => {
    const parts: MessagePart[] = [
      {
        type: "tool",
        toolCallId: "c1",
        toolName: "updateMemory",
        args: { text: `密钥：${KEY}` },
        result: { stored: `api key ${KEY}` },
        state: "output-available",
      },
    ];
    const r = redactMessageParts(parts);
    expect(r.count).toBe(2);
    expect(JSON.stringify(r.parts[0])).not.toContain("sxnbvy8");
  });

  it("不改动 image part 的数据(避免损坏 base64)", () => {
    const longB64 = "A".repeat(64);
    const parts = [
      { type: "image", url: `data:image/png;base64,${longB64}` },
    ] as unknown as MessagePart[];
    const r = redactMessageParts(parts);
    expect(r.count).toBe(0);
    expect(JSON.stringify(r.parts[0])).toContain(longB64);
  });

  it("无密钥时返回原数组语义且 count=0", () => {
    const parts: MessagePart[] = [{ type: "text", text: "普通文本" }];
    const r = redactMessageParts(parts);
    expect(r.count).toBe(0);
    expect((r.parts[0] as { text: string }).text).toBe("普通文本");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/shared/security/__tests__/redact-message.test.ts`
Expected: FAIL（`Cannot find module '../redact-message'`）

- [ ] **Step 3: 实现 redact-message.ts**

```ts
// src/shared/security/redact-message.ts
/**
 * MessagePart 感知的脱敏:只对承载明文的字段(text / reasoning / error.message /
 * tool.args / tool.result)掩码,跳过 image/attachment 等二进制数据,避免破坏 base64。
 * 持久化层(jsonl-store)与渲染层(ChatPanel)共用,保证落盘与显示口径一致。
 */
import type { MessagePart } from "../../main/core/session/message-parts";

import { redactDeep, redactSecrets } from "./secret-detection";

/** 对一组 parts 选择性脱敏,返回脱敏副本与命中数(不修改入参)。 */
export function redactMessageParts(parts: MessagePart[]): {
  parts: MessagePart[];
  count: number;
} {
  let count = 0;
  const out = parts.map((part): MessagePart => {
    if (part.type === "text" || part.type === "reasoning") {
      const r = redactSecrets(part.text);
      count += r.count;
      return { ...part, text: r.text };
    }
    if (part.type === "error") {
      const r = redactSecrets(part.message);
      count += r.count;
      return { ...part, message: r.text };
    }
    if (part.type === "tool") {
      const a = redactDeep(part.args);
      const b = redactDeep(part.result);
      count += a.count + b.count;
      return { ...part, args: a.value, result: b.value };
    }
    return part;
  });
  return { parts: out, count };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/shared/security/__tests__/redact-message.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/shared/security/redact-message.ts src/shared/security/__tests__/redact-message.test.ts
git commit -m "feat(security): 新增 MessagePart 感知脱敏助手(跳过图片/附件二进制)"
```

---

## Task 4: 持久化边界脱敏(jsonl-store)

**Files:**
- Modify: `src/main/core/session/jsonl-store.ts`（`saveMessages` 的 `messageLines` 映射,行 315-323;import 区）
- Test: `src/main/core/__tests__/jsonl-store.test.ts`

- [ ] **Step 1: 写失败测试**

在 `describe("saveMessages + getMessages", ...)` 内追加:

```ts
it("落盘前对消息 content 与 parts 脱敏,读回为掩码版", async () => {
  const store = new JsonlSessionStore(await freshRoot());
  const s = await store.createSession("/ws", "t");
  const KEY = "tp-sxnbvy8nfbqn8ocd7o974kbohq6s1hh3nmak6req8qeenm41";
  await store.saveMessages(s.id, "/ws", [
    {
      id: "m1",
      sessionId: s.id,
      role: "user",
      content: `api key: ${KEY}`,
      timestamp: new Date().toISOString(),
      parts: [{ type: "text", text: `密钥：${KEY}` }],
    },
  ]);
  const read = await store.getMessages(s.id);
  expect(read[0].content).not.toContain("sxnbvy8");
  expect(JSON.stringify(read[0].parts)).not.toContain("sxnbvy8");
});
```

> 注:`freshRoot()` 用该测试文件已有的临时目录辅助;若无同名辅助,复用文件顶部既有的 `mkdtemp` 模式创建根目录(与现有用例一致)。

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/main/core/__tests__/jsonl-store.test.ts -t "落盘前对消息"`
Expected: FAIL（读回仍含明文 `sxnbvy8`）

- [ ] **Step 3: 在 saveMessages 落盘映射处脱敏**

文件顶部 import 区加入:

```ts
import { redactSecrets } from "../../../shared/security/secret-detection";
import { redactMessageParts } from "../../../shared/security/redact-message";
```

把 `messageLines` 映射(现行 315-323)改为:

```ts
const messageLines: MessageLine[] = messages.map((m) => {
  const stripped = m.parts ? stripTransientPreview(m.parts) : m.parts;
  // 持久化边界脱敏:落盘副本掩码,in-memory(发给 LLM 的)不受影响。
  const safeParts = stripped ? redactMessageParts(stripped).parts : stripped;
  return {
    kind: "message",
    id: m.id,
    sessionId,
    role: m.role,
    content: redactSecrets(m.content).text,
    timestamp: m.timestamp,
    parts: safeParts,
  };
});
```

- [ ] **Step 4: 运行测试确认通过(含既有用例)**

Run: `npx vitest run src/main/core/__tests__/jsonl-store.test.ts`
Expected: PASS（新用例 + 既有用例全绿）

- [ ] **Step 5: 提交**

```bash
git add src/main/core/session/jsonl-store.ts src/main/core/__tests__/jsonl-store.test.ts
git commit -m "feat(session): 持久化边界对会话消息脱敏(content + parts),绝不落盘明文"
```

---

## Task 5: 渲染层即时掩码 + 系统提示卡(ChatPanel)

**Files:**
- Create: `src/renderer/components/chat/SystemNoticeCard.tsx`
- Modify: `src/renderer/components/chat/ChatPanel.tsx`（消息 map,行 1049-1097;`renderAssistantParts` 接受脱敏后的 parts）

策略:在消息 map 顶部把 `msg` 过一遍脱敏得到**显示副本**(`chat.messages` 原对象不动,仍是发给 LLM 的明文),用副本渲染;命中(count>0)就在该消息下渲染一张 `SystemNoticeCard`。

- [ ] **Step 1: 创建 SystemNoticeCard 组件**

```tsx
// src/renderer/components/chat/SystemNoticeCard.tsx
import { ShieldCheck } from "lucide-react";

/**
 * 系统提示卡:与模型输出解耦的确定性信号。检测到疑似密钥时由 ChatPanel 渲染,
 * 告知用户已自动遮蔽且不会写入会话记录/记忆——无论模型怎么叙述都不改变这一事实。
 */
export const SystemNoticeCard = ({ message }: { message: string }) => (
  <div className="my-2 flex items-center gap-2 rounded-lg border border-amber-300/60 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-400/30 dark:bg-amber-950/40 dark:text-amber-200">
    <ShieldCheck className="size-4 shrink-0" />
    <span>{message}</span>
  </div>
);
```

- [ ] **Step 2: 在 ChatPanel 引入脱敏与组件**

`ChatPanel.tsx` 顶部 import 区加入:

```ts
import { redactSecrets } from "../../../shared/security/secret-detection";
import { redactMessageParts } from "../../../shared/security/redact-message";
import { SystemNoticeCard } from "./SystemNoticeCard";
```

- [ ] **Step 3: 消息 map 用脱敏副本渲染并按需出卡**

把消息 map(现行 1049-1097)改为(关键改动:计算 `displayParts`/`displayContent`/`secretCount`,渲染用副本,末尾按需插卡):

```tsx
{chat.messages.map((msg, index) => {
  // 显示即时掩码:仅用于渲染,chat.messages 原对象(发给 LLM)不动。
  const sourceParts = msg.parts ?? migrateToParts(msg);
  const { parts: displayParts, count: partsCount } =
    redactMessageParts(sourceParts);
  const { text: displayContent, count: contentCount } = redactSecrets(
    msg.content,
  );
  const secretCount = partsCount + contentCount;

  const userAttachments =
    msg.role === "user"
      ? ((displayParts.filter((p) => p.type === "attachment") as
          | AttachmentPart[]
          | undefined) ?? [])
      : [];
  return (
    <div key={msg.id}>
      <Message from={msg.role}>
        <MessageContent>
          {msg.role === "assistant" ? (
            renderAssistantParts(displayParts)
          ) : (
            <>
              {userAttachments.length > 0 && (
                <AttachmentList attachments={userAttachments} />
              )}
              {displayContent}
            </>
          )}
        </MessageContent>
      </Message>
      {secretCount > 0 && (
        <SystemNoticeCard message="🔒 检测到疑似密钥,已自动遮蔽,不会写入会话记录或记忆。" />
      )}
      {msg.role === "user" && !chat.isLoading && (
        <MessageActions className="opacity-0 group-hover:opacity-100 transition-opacity justify-end">
          <MessageAction
            onClick={() => chat.handleForkSession(msg.id)}
            label={LL.chat_forkHere()}
          >
            <GitBranch className="size-3" />
          </MessageAction>
        </MessageActions>
      )}
      {msg.role === "assistant" &&
        index === chat.messages.length - 1 && (
          <MessageActions>
            <MessageAction
              onClick={() => navigator.clipboard.writeText(msg.content)}
              label="Copy"
            >
              <CopyIcon className="size-3" />
            </MessageAction>
          </MessageActions>
        )}
    </div>
  );
})}
```

> 说明:复制按钮仍用 `msg.content`(原文)——这是用户主动复制自己输入的当前轮内容,不属持久化/泄漏面;若希望连复制也脱敏,可改为 `displayContent`(可在评审时定)。

- [ ] **Step 4: 类型检查 + 启动确认无报错**

Run: `npx tsc --noEmit -p tsconfig.json`(或项目既有的 typecheck 脚本,见 `package.json`)
Expected: 无新增类型错误

- [ ] **Step 5: 提交**

```bash
git add src/renderer/components/chat/SystemNoticeCard.tsx src/renderer/components/chat/ChatPanel.tsx
git commit -m "feat(chat): 渲染层即时掩码密钥 + 检测命中时渲染系统提示卡"
```

---

## Task 6: 手动验证(对照实测截图)

**Files:** 无（运行态验证）

- [ ] **Step 1: 构建并重启应用**(main 进程改动需重新构建)

Run: 项目既有的 dev / build 命令(见 `package.json` 的 `scripts`,如 `npm run dev`)。

- [ ] **Step 2: 复现截图场景**

输入:`xiaomi llm key tp-sxnbvy8nfbqn8ocd7o974kbohq6s1hh3nmak6req8qeenm41 记一下`

预期:
- 当前轮气泡中密钥显示为 `tp••••41`(无明文闪现)。
- 该消息下出现系统提示卡「🔒 检测到疑似密钥…」。
- `updateMemory` 若被调用,memory 文件 `~/.filework/workspace-memory/<key>.json` **不含**该密钥。
- 刷新/重开会话,会话内容(`~/.filework/sessions/...jsonl`)**不含**明文 `sxnbvy8`。

- [ ] **Step 3: 检查落盘文件无明文**

Run: `grep -rl "sxnbvy8" ~/.filework/sessions ~/.filework/workspace-memory 2>/dev/null || echo "无明文残留"`
Expected: `无明文残留`

- [ ] **Step 4: 完成分支收尾**(交由 finishing-a-development-branch 决定 merge/PR)

---

## Self-Review

**Spec 覆盖核对:**
- 检测器纯模块 + CJK 修复 → Task 1 ✅
- containsSecret 复用、memory 拒绝不变 → Task 2 ✅
- MessagePart 选择性脱敏、跳过二进制 → Task 3 ✅
- 持久化边界遮蔽(content + parts) → Task 4 ✅
- 显示即时掩码(全链路含用户输入) → Task 5(`displayContent` 覆盖用户气泡) ✅
- 系统提示卡为真相来源、与模型解耦 → Task 5 ✅
- 日志脱敏:spec 列为「ai-handlers 已知日志点套 redactSecrets」。**本计划未含**——经核查 jsonl-store 落盘已覆盖主要泄漏面,而 ai-handlers 的 `console.log` 是否打印消息正文需实现时确认;**留作 Task 4 之后的可选补充**,若实现者发现 ai-handlers 打印了 tool 结果正文,补一行 `redactSecrets` 包裹即可。(此为有意的范围标注,非遗漏。)
- memory 特例(reject 而非 mask) → Task 2 保持现状 ✅

**占位符扫描:** 无 TBD/TODO;每个代码步骤含完整代码。

**类型一致性:** `redactSecrets(text)→{text,count}`、`redactDeep(value)→{value,count}`、`redactMessageParts(parts)→{parts,count}` 三个签名在 Task 1/3/4/5 引用一致。

**已知风险:** Task 5 的脱敏在每次渲染运行;消息体量小,先不加 `useMemo`(YAGNI),若大会话出现卡顿再优化。
