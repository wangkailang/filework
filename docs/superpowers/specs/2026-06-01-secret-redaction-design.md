# 密钥纯防御脱敏设计(persist-boundary + 系统卡)

**日期**:2026-06-01
**作者**:wangkailang(经 Claude 协作)
**状态**:已通过设计评审,待写实现计划

## 背景与问题

实测中,用户输入「xiaomi llm key tp-sxnbvy8...」类消息时暴露出一连串问题:

1. **检测被绕过**:`containsSecret` 仅按 `\s+` 切词,中文里密钥常写成 `API密钥:tp-xxxx`(全角冒号 `:` U+FF1A + token 紧贴无空格),整串被粘成一个含汉字的 token,过不了 `^[A-Za-z0-9_-]+$` 高熵检测而被放行。(已先行修复:新增 `SECRET_TOKEN_SPLIT`,切词时按 CJK 文字 + 全/半角标点切分。)
2. **明文穿透整条链路**:密钥出现在用户输入、模型回显、工具参数卡、session 文件、日志里,处处明文。
3. **模型成了"是否存储"的真相来源**:`updateMemory` 返回 `success:false` 后,较弱的模型(minimax-m2.7)仍叙述"已经存好啦",甚至建议把 key 写进 `.env`/`AGENTS.md`(git 跟踪的明文,更糟)。模型自陈"没有读取 Memory 的工具,无法验证"。

正则只是其中一环。根因是**整套设计把"是否落盘/是否泄漏"交给 LLM 去叙述**,而 LLM 既看不到真相又会编造。

## 目标与范围

**目标定位:纯防御** —— 密钥只要出现就拦截 + 脱敏,绝不落盘、不进日志、不在持久化记录里留明文。**不**追求让 agent 真去使用该密钥,因此**不做**密钥链 / 保险库 / 引用句柄那一类"密钥治理"。

**边界决策**(逐项与用户确认):

| 维度 | 决策 |
|---|---|
| 目标 | 纯防御:绝不泄漏 / 落盘 |
| 脱敏范围 | 全链路,含用户自己输入的消息 |
| 持久化时机 | 持久化边界遮蔽(非入口):in-memory 当前轮保留明文,LLM 当轮可应答;落盘 / 日志 / memory 前一律遮蔽 |
| 显示 | renderer 渲染时即时掩码,当前轮气泡也不露明文 |
| 检测信号 | 系统提示卡(确定性,与模型输出解耦)为真相来源 |
| 架构 | 方案 A:持久化收口处单点遮蔽 + 返回计数给调用方发 IPC |

**明确不做(YAGNI)**:密钥链 / Vault / 1Password 集成、引用句柄注入、密钥轮换、全局 console 包裹、让 agent 解密使用密钥。

## 架构

```
新增  src/main/core/security/secret-detection.ts   ← 检测器单一事实源(纯函数,无 node 依赖)
      ├─ containsSecret(text): boolean              (从 workspace-memory.ts 迁入)
      ├─ redactSecrets(text): { text, count }       (新增:定位并掩码)
      └─ 共用 SECRET_PATTERNS / SECRET_KEYWORD / SECRET_TOKEN_SPLIT / looksLikeSecretToken

改动  workspace-memory.ts        改为 re-export / re-import 上面的 containsSecret(行为不变)
      jsonl-store.ts             saveMessages 落盘前跑 redactSecrets,返回 { redactedCount }
      ai-handlers.ts             据 redactedCount 与 updateMemory 拒绝 → 发 ai:stream-system-notice;已知 agent 日志点过 redactSecrets
      message-parts.ts           新增 SystemNoticePart 类型并入 union
      preload/index.ts           新增 onStreamSystemNotice 桥接
      useStreamSubscription.ts   收 ai:stream-system-notice → push SystemNoticePart
      ChatPanel.tsx              renderAssistantParts 增 case → SystemNoticeCard;TextPart/ToolPart 渲染时套 redactSecrets
```

`secret-detection.ts` 必须是**纯 TS(仅正则,无 node import)**,以便 renderer(浏览器环境)也能直接 import 做即时掩码。

## 核心:detector 模块

```ts
/** 命中即返回 true(memory 拒绝用)。接口与现状一致。 */
export function containsSecret(text: string): boolean;

/**
 * 定位并掩码所有命中片段。
 * 掩码格式:保留首 2 + 末 2,中间固定 4 个圆点(不暴露真实长度)→ "tp-••••41"。
 * 过短(脱敏后无意义)的命中整体替换为 "••••"。
 * @returns text 脱敏后文本;count 命中数(0 表示未命中)。
 */
export function redactSecrets(text: string): { text: string; count: number };
```

- `redactSecrets` 与 `containsSecret` 共用同一套 pattern + 分词器(含 CJK 分词修复),保证"检测到的"与"被掩码的"一致。
- 纯函数、无副作用、无 IO,main 与 renderer 共用同一份实现。

## 数据流

### 持久化(方案 A 收口)
- `saveMessages(messages)`:对**落盘副本**遍历 `MessageLine.parts`,`redactSecrets` 处理 `TextPart.text` 与 `ToolPart` 的 `args`/`result`(序列化文本)。**不修改 in-memory parts**(当前轮 LLM 仍需明文)。
- 累加 `count` → 返回 `{ redactedCount }`。`jsonl-store` 不依赖 IPC,分层干净。

### 系统提示卡(真相来源)
```ts
interface SystemNoticePart {
  type: "system-notice";
  level: "info" | "warning";
  message: string;     // 例:「🔒 检测到疑似密钥,已自动遮蔽,不会写入会话记录或记忆」
  timestamp: string;
}
```
- 触发源:① `saveMessages` 返回 `redactedCount > 0`;② `updateMemory` 返回 `action:"rejected"`。
- 两者都在 ai-handlers 发 `ai:stream-system-notice`,经 preload → useStreamSubscription → push 一个 `SystemNoticePart`。
- 卡片视觉独立于 assistant 文本气泡;模型怎么叙述都不改变这张卡陈述的事实。

### 显示(即时掩码)
- renderer 在渲染 `TextPart` / `ToolPart` 时套 `redactSecrets`,**当前轮气泡也不露明文**,不依赖落盘往返。
- 这是纯展示层处理,不改 in-memory / 不改发给 LLM 的内容。

### memory(特例:拒绝而非掩码)
- durable store 连掩码版都不存。维持现有"命中即 reject + `MemorySecretError`"(强于掩码)。`updateMemory` 拒绝路径已返回 `tellUser` 指令(保留,作为对模型口径的辅助;真相仍以系统卡为准)。

## 行为预期(对照实测截图)
- 当前轮 LLM 看得到明文(persist-boundary,非入口)→ 正常应答。
- 落盘 / 重载会话 / 日志:全为 `tp-••••41`,含用户自己输入那条。
- UI 当前轮气泡即时掩码,无明文闪现。
- 无论模型说"已存"或"存不进",**系统卡明确告诉用户:已遮蔽、未写入**。

## 日志
仅在 ai-handlers 已知 agent 日志点(任务执行、tool 结果)套 `redactSecrets`;**不**全局包裹 console(YAGNI)。

## 错误处理
- `redactSecrets` 对任意输入(含空串 / 超长 / 非字符串经类型保护)安全返回;落盘脱敏失败不应阻断保存 —— 兜底为"按原样保存前再跑一次最小检测",失败则记一条(脱敏后的)warning,不抛。
- 系统卡事件发送失败不影响落盘与对话流(best-effort)。

## 测试
- `secret-detection.test.ts`
  - `redactSecrets` 对三种写法命中并掩码:全角冒号紧贴 / ASCII 冒号带空格 / 纯英文 keyword。
  - 不误伤:普通中文、URL、文件路径、40-hex SHA、UUID。
  - 掩码格式断言:`xx••••xx`;过短命中 → `••••`;`count` 准确。
  - `containsSecret` 迁移后行为与原 23 个用例一致。
- `jsonl-store` 测试:含密钥的 message 落盘后读回为掩码版,in-memory 原对象不变,`redactedCount` 正确。
- workspace-memory 既有 23 个用例在迁移 import 后保持绿。

## 不在本设计内
- 让 agent 实际使用密钥、密钥链 / 保险库、引用句柄、密钥轮换、全局 console 脱敏、对历史已落盘 session 文件的回溯清洗(可作为后续单独任务)。
