# Subagent 模式

主 agent 把"独立、可隔离、可并行"的子任务委派给一批 fresh 子 agent。子 agent 在**隔离上下文**里跑、受**硬性 turn / token / wall-clock 三上限**约束、能力是主 agent 的**子集**、过程在 UI 上**实时可观测**,跑完把结构化报告交回主 agent 下一回合消费。

对标 Claude Code 的 Task 工具。

---

## 为什么有这个

单层 agent 有两个天花板:

1. **上下文污染** —— "读 50 个文件总结一句话"这类探索,把 50 个文件的全文灌进主对话,挤占后续推理的上下文预算。
2. **串行瓶颈** —— "分别调研 A / B / C 三个主题"本可并行,单层只能一个个来。

Subagent 把这类工作下放给隔离的子 agent:子 agent 的中间过程不进主上下文(只回摘要),且能并行扇出。

源码集中在 `src/main/ipc/agent-tools.ts`(工具)、`src/main/ipc/fork-pool.ts` + `fork-skill-runner.ts`(执行)、`src/main/core/agent/agent-loop.ts`(硬上限)、`src/renderer/components/chat/SubagentCard.tsx`(UI)。

---

## 怎么触发

**没有按钮/开关。** 有两条路径。

### 路径 1:主 agent 自主委派(主路径)

`spawnSubagent` 是一个 **LLM 可调用工具**,注册在主 agent 的工具集里。**你不直接调用它 —— 模型读懂任务后自己决定要不要开。** 你能做的是给一个"明显该委派"的任务,让模型命中它。

触发条件(写在工具 description 的 WHEN TO USE 里):

- **真正独立、可并行**的多子任务
- **大体量、想隔离上下文**的探索
- **同模式扇出**(对 N 个输入做同样处理)

模型**不会**(也不应)开 subagent 的情况:单步/线性任务、需要和用户来回澄清的任务、子任务间有先后依赖。

#### 触发例子

会触发(独立可并行):

```
并行调研 zustand、jotai、valtio 三个库的核心区别,每个给我三句话
```
```
同时分析 src/main、src/renderer、src/preload 三个目录的职责,各回一段总结
```
```
对 ~/docs 下这 5 个 PDF 各做一次摘要,最后汇总成一张表
```

会触发(隔离大体量探索):

```
通读 src/main/ipc 下所有 *-handlers.ts,只回一句话告诉我 IPC 的总体分层
```

**不会**触发(模型应自己做):

```
帮我把 README 里的标题改成「Filework」          # 单步
先建表再插数据再查询                              # 有先后依赖
这个报错是什么意思?                              # 单个问答
```

系统提示与工具 description 已做引导:**"研究/对比/扇出类、可拆成独立并行单元的任务,优先用 `spawnSubagent` 并行,而非串行搜索"**。所以上面这些例子应当能让模型主动开 subagent(通常先 `createPlan` 给出计划,再用一次 `spawnSubagent` fan-out 执行独立步骤)。

> ⚠️ 仍取决于模型是否"愿意"用这个工具——较弱的模型可能宁可自己串行做,或先 `askClarification`。若没触发,直接点名最稳:**"用 spawnSubagent 工具并行开 N 个子 agent,分别…,不要先建计划"**。

### 路径 2:Skill fork 模式(既有)

Skill 的 `SKILL.md` frontmatter 写 `context: fork`,该 skill 被激活时就以子 agent 方式执行(走 `fork-skill-runner`)。注意:此路径事件仍走旧的 `ai:stream-*` 通道,**不进**新的子任务进度卡。

---

## 工具参数(spawnSubagent)

模型按下面的 schema 调用(定义在 `agent-tools.ts` 的 `spawnSubagentInputSchema`):

| 字段 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `tasks[]` | ✅ | — | 1–6 个并行子任务。仅当任务真正独立时才给多个 |
| `tasks[].goal` | ✅ | — | 一句话目标。子 agent **看不到**父对话 |
| `tasks[].prompt` | ✅ | — | 完整指令 + 全部上下文(文件路径、约束、要返回什么)。假设零共享记忆 |
| `tasks[].profile` | — | — | 可选: `researcher` / `code_reviewer` / `test_analyst` / `doc_summarizer` |
| `tasks[].outputFormat` | — | `json` | `summary` / `json` / `answer` / `patch`。`json` 时默认按 RESULT schema 校验 artifacts |
| `tasks[].allowedTools` | — | 内置只读检查工具集 | 子 agent 检查工具白名单会被收敛到只读工具;写入、memory、automation、delegation 会被过滤。`submitSubagentResult` 不通过该字段授权,会固定额外注入 |
| `tasks[].allowedSkills` | — | 空 | 子 agent skill 白名单,**只能是你的子集**;省略时不注入 skills,避免膨胀 child 上下文 |
| `tasks[].maxTurns` | — | 10 / researcher 16 | 子 agent 回合数上限 |
| `tasks[].maxTotalTokens` | — | 120000 / researcher 180000 | 子 agent 累计 token 上限 |
| `tasks[].maxWallMs` | — | 120000 / researcher 300000 | 子 agent 墙钟上限(毫秒) |
| `concurrency` | — | 3 | 最大并发子任务数(钳到 1–4) |
| `failFast` | — | false | 首个失败的子任务取消其余 |

子 agent 路径会额外注册并在 prompt 的 `Available tools` 中展示 `submitSubagentResult` 安全工具。子 agent 一旦有证据支持的 finding,应先调用该工具提交结构化结果;如果随后命中 token/wall 上限,runner 仍能把已提交 artifacts 判为 `usable_partial`。最终返回给模型的 tool-result:`{ success, batchId, summary, reports: [{ goal, status, resultQuality, usable, summary, artifacts, usage, error, unusableReason }] }`。模型在下一回合只消费 `usable=true` 的报告。

执行纪律:子 agent 获得第一条有证据支撑的 finding 后,必须先用 `submitSubagentResult(status: "partial")` 落盘,再继续调用其它检查工具补充覆盖面。这样即使命中 token/timeout,lead 仍能采纳已提交结论。

---

## 三个硬上限

统一收口到 `AgentLoop`(`src/main/core/agent/agent-loop.ts`),由 `AgentLoopConfig` 的三个字段强制:

| 上限 | 字段 | 子 agent 默认 | 命中后 |
|---|---|---|---|
| 回合数 | `maxStepsPerTurn` | 10 / researcher 16 | `stopReason="max_steps"` |
| 累计 token(in+out) | `maxTotalTokens` | 120000 / researcher 180000 | `stopReason="token_budget"` |
| 墙钟 | `maxWallMs` | 120000 / researcher 300000 | `stopReason="wall_clock"` |

机制:`AgentLoop` 内部持有 `internalController`,与外部 `signal` 经 `AbortSignal.any` 合并后传给 `streamText`。token 在每个 `finish-step` 累加判断、墙钟用 `setTimeout`,任一命中即 `internalController.abort()`。命中硬上限时 `agent_end` 以 `status="completed"` + `stopReason` 返回(**已产出内容有效,只是被截断**),不是 `cancelled`。

子 agent 报告状态映射(`fork-skill-runner.ts`):`token_budget → token_limit`,`wall_clock → timeout`,`max_steps → ok`。

> 主 agent 默认**不设** token/wall 上限(避免误杀长任务);硬上限是 subagent 的约束。

默认常量在 `src/main/core/agent/sub-agent-contract.ts`:`DEFAULT_SUB_AGENT_MAX_TURNS=10`、`DEFAULT_SUB_AGENT_MAX_TOTAL_TOKENS=120_000`、`DEFAULT_SUB_AGENT_MAX_WALL_MS=120_000`。`researcher` 的放大预算在 `src/main/ipc/agent-tools.ts` 中解析。

---

## 能力继承与限制

1. **天然继承** —— 子 agent 走同一套 `buildAgentToolRegistry` / `resolveSandboxConfig`(沙箱)/ `buildApprovalHook`(审批),工具行为与主 agent 一致。
2. **子集限制(主 agent 的硬边界)**:
   - **工具**:`allowedTools` 取父子交集(`intersectTools`),子请求超出父集的部分被裁掉。
   - **skill**:主 agent 把可委派的 skill 全集(`skillRegistry.listUserVisible()`)作为 `parentAllowedSkills` 传入;子请求的 `allowedSkills` 与之求交,选中的 skill 描述经 `buildSubagentSystemPrompt` 注入子 agent 系统提示。
   - **双层兜底**:即便提示里注入了某 skill,工具白名单仍取交集,子 agent 调不到父没放行的工具。
3. **防递归** —— 子 agent 路径不传 `enableSubagent`(缺省 false),因此**子 agent 拿不到 `spawnSubagent`,无法再委派**,杜绝指数级扇出。

---

## 上下文隔离

每个子 agent 一个独立 `LocalWorkspace` + 独立 history。系统提示明确告诉子 agent"你看不到主对话,所需信息都在你的 prompt 里"。主 agent 给的 `prompt` 字段必须自包含。

---

## 可观测性

独立的 `ai:subagent-*` IPC 事件族(不复用 `ai:stream-*`,避免污染主任务的文本/turn-summary 聚合),每条携带路由三元组 `{ parentTaskId, batchId, childTaskId }`:

| 事件 | 时机 | UI 效果 |
|---|---|---|
| `ai:subagent-spawn` | 批次启动前 | 立即出现「子任务委派」进度卡,每子任务一行 |
| `ai:subagent-tool-call` | 子 agent 调工具 | 该行 step 数 +1、追加工具 |
| `ai:subagent-tool-result` | 工具返回 | 工具行切成功/失败 |
| `ai:subagent-child-usage` | 子 agent 结束 | 该行显示 token 用量 |
| `ai:subagent-report` | 子任务收束 | 该行切终态 + 显示摘要 |

渲染层(`useStreamSubscription.ts`)按 `parentTaskId === 当前主任务` 过滤,`batchId` 定位 `SubagentMessagePart`、`childTaskId` 定位卡内某一行。组件 `SubagentCard.tsx` 是一张可折叠卡:标题显示「N 子任务 · 并发 M · 完成 X/N」,每行显示 goal、状态徽章(进行中/完成/失败/超时/token 超限)、步数、token,完成后可展开看摘要。

`spawnSubagent` 自身的通用工具气泡在渲染层被抑制(一次 fan-out 是 N 个子 agent,塞不进单结果的 ToolPart)。

> 失败/取消的子任务也会发 `ai:subagent-report`(含 failFast 级联未启动的合成 cancelled 报告),保证 UI 不会有行永远停在 spinner。

### 钻入面板(查看子 agent 执行过程)

进度卡是**结果级**可观测;要看子 agent **内部过程**(调了什么工具、参数/返回、推理、流式文本),点子任务行钻入:

- 点 `SubagentCard` 任一行 → 派发 `filework:open-subagent` 事件 → 右侧 `ContextDock` 切到 **subagent tab**,用主线程同一套渲染器(`Tool` 气泡 / `ReasoningBlock` / 文本)回放该子 agent 的完整时间线。
- 面板头部显示 goal / 状态 / 步数 / token / 耗时;底部 chip 一键在同批兄弟子任务间切换;运行中实时流式追加,完成后附摘要/错误。
- 数据来源:`SubagentChildView.parts`,由 `useStreamSubscription` 从 `ai:subagent-delta / -tool-call / -tool-result` 累积(args/result 事件已带;delta 通道在此被消费)。
- 取舍:`parts` 默认仅内存保留,**不强制持久化**(避免 JSONL 膨胀)。刷新/重载后过程不可回看,面板显示"无过程记录,仅保留摘要"——摘要仍在 report 里。

承载组件:[`SubagentTracePanel.tsx`](../src/renderer/components/chat/SubagentTracePanel.tsx);Dock 接线见 [`ContextDock.tsx`](../src/renderer/components/dock/ContextDock.tsx) 的 `DockTab "subagent"`。

---

## 数据流一图

```
主 AgentLoop
  └─ 模型调用 spawnSubagent(tasks[], concurrency, failFast)
       ├─ 发 ai:subagent-spawn ──────────────→ UI 建进度卡
       └─ runForkBatch(有界并发 + failFast)
            └─ 每个子任务: createForkSkillRunner → 独立 AgentLoop
                 ├─ 继承沙箱/审批,allowedTools/Skills 取父子交集
                 ├─ 三硬上限由 AgentLoop 强制
                 ├─ 事件 → ai:subagent-delta/tool-call/tool-result ─→ UI 更新该行
                 └─ buildReport → ai:subagent-report ──────────────→ UI 切终态
       └─ reports[] 作为 tool-result 回到主 AgentLoop → 模型下一回合综合答复
```

---

## 相关源码索引

| 文件 | 作用 |
|---|---|
| [`agent-tools.ts`](../src/main/ipc/agent-tools.ts) | `spawnSubagentTool` 工具 + schema + 父子交集 + 注册门控 |
| [`sub-agent-contract.ts`](../src/main/core/agent/sub-agent-contract.ts) | `SubAgentContract` / `SubAgentReport` / `buildReport` / 默认上限常量 |
| [`fork-pool.ts`](../src/main/ipc/fork-pool.ts) | `runForkBatch` 有界并发 + failFast + `ai:subagent-report` 广播 |
| [`fork-skill-runner.ts`](../src/main/ipc/fork-skill-runner.ts) | 单个子 agent runner + `ai:subagent-*` 事件路由 + 状态映射 |
| [`agent-loop.ts`](../src/main/core/agent/agent-loop.ts) | 三硬上限(token/wall/steps)+ `stopReason` |
| [`events.ts`](../src/main/core/agent/events.ts) | `AgentStopReason` + `agent_end.stopReason` |
| [`system-prompt.ts`](../src/main/ipc/system-prompt.ts) | `buildSubagentSystemPrompt` + 委派引导 |
| [`message-parts.ts`](../src/main/core/session/message-parts.ts) | `SubagentMessagePart` / `SubagentChildView` |
| [`SubagentCard.tsx`](../src/renderer/components/chat/SubagentCard.tsx) | 可折叠实时进度卡 |
| [`useStreamSubscription.ts`](../src/renderer/components/chat/useStreamSubscription.ts) | 子任务事件聚合 |

---

## 已知限制

- **不支持二级嵌套** —— 子 agent 不能再 spawn(防递归)。需要多层时由主 agent 跨回合编排。
- **子 agent 不能问用户** —— `askClarification` 不会回到用户;缺信息时子 agent 在结果里声明 blocker 并停。
- **子任务间不通信** —— 并行执行、互相不可见;有依赖的工作要主 agent 自己分回合做。
- **Skill body 注入是二期** —— 当前注入 skill 描述 + 工具白名单交集;完整 skill 正文注入留后续。
