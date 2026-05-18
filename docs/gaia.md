# GAIA Harness

filework agent 的本地化 GAIA 跑分工具。不需要 HF leaderboard 提交，所有结果落地到本地目录。

## 为什么有这个

之前所有 "+X GAIA 分" 的估算都是理论值。Phase 1（[#71](https://github.com/wangkailang/filework/pull/71)）+ Phase 2（[#73](https://github.com/wangkailang/filework/pull/73)）让我们能跑真实分数、对每次改动做回归对比。

源码：[`src/eval/gaia/`](../src/eval/gaia)

---

## 一次性准备

### 1. Hugging Face 账户 + GAIA license

GAIA 是 gated dataset。三步：

```bash
# (a) 浏览器登录 HF 后接受 license：
#     https://huggingface.co/datasets/gaia-benchmark/GAIA
#     必须点 "Agree and access repository"，否则下载会 403。

# (b) 拿 token（Read 权限即可）：
#     https://huggingface.co/settings/tokens

# (c) 终端登录
hf auth login

# 验证
hf auth whoami   # 应该输出你的 HF 用户名
```

### 2. 下载数据集

```bash
hf download gaia-benchmark/GAIA \
  --repo-type dataset \
  --local-dir ~/datasets/gaia

# 验证
ls ~/datasets/gaia/2023/validation/metadata.parquet
# 165 个题目（L1: 53 / L2: 86 / L3: 26）+ 附件
```

GAIA 现在用 Parquet 而不是 JSONL。loader 用 [`hyparquet`](https://www.npmjs.com/package/hyparquet) 直接读。

### 3. 拿 LLM Provider 的 API key

最便宜的选择是 DeepSeek（L1 全集约 $0.20）。其它选项见下方 "Provider 选型"。

```bash
# 在你自己的 shell 里 export（**不要**贴到 chat 里）
export GAIA_EVAL_API_KEY=sk-...你的-key...

# 加到 ~/.zshrc 持久化
echo 'export GAIA_EVAL_API_KEY=sk-...' >> ~/.zshrc
```

可选的工具 API key（不设则对应工具不会注册到 eval registry）：

```bash
export TAVILY_API_KEY=tvly-...      # 启用 webSearch
export FIRECRAWL_API_KEY=fc-...     # 启用 webScrape
```

---

## Quick Start

### 5 题 smoke（验证一切就绪）

```bash
pnpm gaia-eval \
  --dataset ~/datasets/gaia/2023/validation \
  --provider deepseek \
  --model deepseek-chat \
  --smoke
```

`--smoke` 等同于 `--level 1 --limit 5`。耗时约 3 分钟，约 $0.005。

### L1 全集 baseline

```bash
pnpm gaia-eval \
  --dataset ~/datasets/gaia/2023/validation \
  --provider deepseek \
  --model deepseek-chat \
  --level 1 \
  --output ~/gaia-runs/baseline-$(date +%Y-%m-%d)
```

53 题，约 30–60 分钟（视 rate limit），DeepSeek 约 $0.20。

### 跨运行 diff

```bash
# 跑改动后的版本
pnpm gaia-eval ... --output ~/gaia-runs/after-tuning

# 对比
pnpm gaia-eval-diff ~/gaia-runs/baseline-2026-05-17 ~/gaia-runs/after-tuning
# 会在 after-tuning/ 目录写 diff-vs-baseline.md
```

---

## CLI 参数

### `gaia-eval`

| 参数 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `--dataset <dir>` | ✅ | — | GAIA validation 目录路径（含 `metadata.parquet` 或 `metadata.jsonl`） |
| `--provider <name>` | ✅ | — | `anthropic` / `openai` / `deepseek` / `minimax` / `custom` |
| `--model <id>` | ✅ | — | 模型 ID，e.g. `deepseek-chat`, `claude-sonnet-4-6`, `gpt-4o` |
| `--api-key <key>` | — | env `GAIA_EVAL_API_KEY` | provider 的 API key |
| `--base-url <url>` | — | — | 覆盖默认 endpoint（OpenAI 兼容 provider 用） |
| `--level 1\|2\|3\|all` | — | `1` | 难度过滤 |
| `--limit <N>` | — | 不限 | 取前 N 题 |
| `--smoke` | — | false | 等同 `--level 1 --limit 5` |
| `--temperature <n>` | — | `0` | 采样温度。`0` 是确定性贪婪解码（默认，便于做 diff 对比）。可填 `0.7` 之类做探索；推理模型（o1/o3/o5/gpt-5 reasoning）必须传 `none`（也接受 `default`/`off`），否则 SDK 会打 `temperature is not supported` 警告 |
| `--output <dir>` | — | `~/gaia-runs/<timestamp>` | 输出目录 |

退出码：
- `0` 跑完（哪怕全 fail 也算 0，summary 已落盘）
- `1` 参数错误（缺 dataset / key / 等等）
- `2` 运行时报错

### `gaia-eval-diff`

```bash
pnpm gaia-eval-diff <baseline-dir> <current-dir> [--output <path>] [--stdout]
```

| 参数 | 说明 |
|---|---|
| `<baseline-dir>` | 老 run 的输出目录 |
| `<current-dir>` | 新 run 的输出目录 |
| `--output <path>` | 写到指定路径（默认 `<current>/diff-vs-baseline.md`） |
| `--stdout` | 同时打印到 stdout |

---

## 答案协议与 Reflection Gate

GAIA 题面要求 agent 以 `FINAL ANSWER: <答案>` 收尾。harness 装了一条 **reflection gate**（[`reflection-gate.ts`](../src/main/core/agent/reflection-gate.ts)），在每次 `streamText` 收束后检测三类问题并自动 retry：

1. **`missingFinalAnswer` rule** — 检测到 `finalText` 里没有合法的 `FINAL ANSWER:` 行（无、空、被遮蔽）就 retry。
2. **Tool-less retry** — retry 时强制 `tools: {}`（`forceNoTools: true`），模型只能基于已收集的信息收尾，避免它在 retry pass 上又把 step budget 用光。
3. **LLM 答案形态验证（verifier）** — 当 deterministic rule 都没触发、模型确实给出了 `FINAL ANSWER` 时，gate 再做一次小 LLM 调用，问"答案的单位/量级/格式是否跟题目字面要求一致"。例如题目问 "how many **thousand** hours" 而答 "17000"（小时）会被 verifier 标 retry。verifier **不验事实对错**，只验形态对齐。

verifier 的 prompt 在 [`runner.ts → buildAnswerVerifierPrompt`](../src/eval/gaia/runner.ts) 里组装，包含题目原文 + 模型的 final response 尾部 ~1200 字。

成本：verifier 仅在模型已经发出 `FINAL ANSWER` 时才花一次 LLM 调用（rule 触发时短路）。DeepSeek 上单题 < $0.001，53 题 L1 全集追加约 $0.05。`createReflectionGate({ llmFallback: false })` 可关掉。

retry 上限由 `AgentLoopConfig.maxReflections`（默认 `2`）控制，所以单题最多 1 + 2 = 3 次 streamText 调用。

System prompt 端的配合：

- **Answer protocol** 章节：硬要求每个回复必须以 `FINAL ANSWER:` 行收尾，找不到答案就写 `FINAL ANSWER: unknown`。
- **Stop conditions** 章节：3 次尝试后没找到答案就 graceful give up，emit `unknown`。
- **Unit interpretation** 章节：明确告诉模型 "how many thousand X" 单位是"千 X"，避免 Kipchoge 类的单位混淆（`17000` vs `17`）。

---

## 可复现性

默认 `--temperature 0` → 贪婪解码 → 同样输入永远产生同样输出。verifier 的 LLM 调用也走 `llmTemperature: 0`。这是 harness 调参的前提 —— 不开确定性，5 题 smoke 上一两个 question 在 lucky/unlucky 之间翻面，harness 改动的信号会被采样噪声完全淹没。

什么时候要 opt out：

| 场景 | 建议 |
|---|---|
| 评估 harness / scorer / prompt 改动 | 保持默认 `--temperature 0` |
| 测模型稳健性 / 走多样路径 | `--temperature 0.7` |
| 跑 OpenAI 推理模型（o1/o3/o5/gpt-5 reasoning） | `--temperature none`，SDK 才不会丢警告。这些模型本身做内部 CoT 采样，**不可能完全确定化** |
| 跑 DeepSeek-R1 / 第三方代理上的推理模型 | 通常仍然接受 `temperature`，默认 0 即可；如果代理报错再降级到 `none` |

启动日志会显式打温度：

```
[gaia] level=1 limit=5 provider=deepseek model=deepseek-chat temperature=0
```

---

## 输出文件结构

```
<outputDir>/
├── summary.json              # 总分、各 level 准确率、成本、failure tag 分布
├── failures.md               # 按 tag 分组的失败报告 + 每 tag 3 个例题
├── tool-usage.md             # 工具调用统计（次数 / 中位耗时 / 错误率）
├── diff-vs-baseline.md       # 仅在跑过 gaia-eval-diff 后存在
├── per-question/
│   └── <task_id>.json        # 单题完整记录
├── events/
│   └── <task_id>.jsonl       # 单题 AgentEvent 流（debug 用）
└── workspaces/<task_id>/     # 单题运行时的临时 dir（默认跑完清理）
```

### `summary.json` 关键字段

```json
{
  "config": { "level": "1", "model": "deepseek-chat", "startedAt": "2026-05-17T20:00:00Z" },
  "totals": { "questions": 53, "passed": 22, "failed": 31 },
  "accuracy": 0.415,
  "byLevel": { "1": { "n": 53, "passed": 22, "accuracy": 0.415 } },
  "duration": { "totalMs": 1800000, "medianMs": 32000 },
  "cost": { "totalUsd": 0.19, "perQuestionMedianUsd": 0.003 },
  "failureTags": { "attachment_not_processed": 4, "wrong_answer_correct_path": 12, "no_tool_calls": 8 }
}
```

> `reflection_not_fired` 现在应该恒为 0（gate 在 GAIA 默认启用，每题都会触发 verdict）。出现就是 harness 配置 bug。

### `per-question/<task_id>.json` 关键字段

```json
{
  "taskId": "c61d22de-...",
  "level": 1,
  "question": "...",
  "attachment": "/tmp/.../some.pdf",
  "groundTruth": "42",
  "predicted": "approximately 42",
  "passed": true,
  "normalized": { "groundTruth": "42", "predicted": "approximately42" },
  "durationMs": 28100,
  "tokenUsage": { "input": 12480, "output": 1820, "total": 14300 },
  "estimatedCostUsd": 0.0044,
  "toolCalls": [
    { "name": "webFetch", "args": { "url": "..." }, "result": "...", "durationMs": 1200 }
  ],
  "stepCount": 5,
  "reflectionFired": false,
  "failureTags": [],
  "eventsPath": "events/c61d22de-....jsonl"
}
```

---

## Failure Tags（启发式分类）

每个未通过的题最多被打多个 tag，对应不同的失败模式。

| Tag | 触发条件 | 该往哪查 |
|---|---|---|
| `no_tool_calls` | 整题没调用任何工具 | system prompt 是否引导直接回答；模型选型是否过弱 |
| `tool_error` | 至少一个工具返回 error 但 agent 没换路径 | `per-question/*.json` 的 `toolCalls[]` 看具体哪个 |
| `attachment_not_processed` | 题有附件但所有工具调用都没碰过那个路径 | 附件类型可能没有对应 parser（如 audio/video） |
| `context_overflow` | `agent_end.error.message` 含 "context" | 调大 `maxStepsPerTurn` 或检查 compaction |
| `reflection_not_fired` | 长链（≥5 turn）但 `reflection_verdict` event 缺席 | 自从 reflection-gate 在 GAIA 默认启用后，正常情况下不会出现。若出现，说明 gate 被外部代码绕过了，查 `runOneQuestion` 的 AgentLoop 装配 |
| `wrong_answer_correct_path` | 工具调用 ≥2 次，最终答案错 | 比 `predicted` vs `groundTruth`：常见原因 (1) 模型推理错（如 Kipchoge 单位混淆），(2) 答案带了题目已经说过的单位（scorer 会用 `tryLeadingNumber` 兜底，但兜不住的情况仍然 fail），(3) 列表答案的元素拼写不对 |
| `timeout` | 单题超 5 分钟（默认） | agent 卡死 or 任务真需要更多时间 |
| `exception` | runner 自己抛了 | 看 `per-question/*.json` 的 `exception` 字段堆栈 |

源码：[`runner.ts → tagFailures`](../src/eval/gaia/runner.ts)

---

## Provider 选型

L1 全集（53 题）成本估算：

| Provider | 模型 | $/MTok in/out | L1 估算 $ | 适用场景 |
|---|---|---|---|---|
| **deepseek** | `deepseek-chat` (V3) | 0.14 / 0.28 | **~$0.20** | 最便宜 baseline，推荐先跑 |
| deepseek | `deepseek-reasoner` (R1) | 0.55 / 2.19 | ~$1.50 | 推理重的题强 |
| anthropic | `claude-haiku-4-5` | 1 / 5 | ~$1–2 | 性价比 |
| anthropic | `claude-sonnet-4-6` | 3 / 15 | ~$3–5 | 论文标准对照点 |
| anthropic | `claude-opus-4-7` | 15 / 75 | ~$15–25 | 上限验证用 |
| openai | `gpt-4o` | 2.5 / 10 | ~$3–5 | OpenAI 标准 |

价格表硬编码在 [`pricing.ts`](../src/eval/gaia/pricing.ts) 的 `MODEL_PRICES`。新模型加一行即可。

注：上表是裸 agent 调用的成本估算。reflection gate 的 LLM verifier 会在每个有 `FINAL ANSWER` 的题上多花一次小 LLM 调用（输入 ~500–1200 tokens，输出 < 100 tokens），按 DeepSeek 价格 L1 全集追加约 $0.05。如果 verifier 用更贵的模型（gate 默认复用 agent model）就按比例放大。

### Rate Limit 注意

- **DeepSeek**：默认 60 RPM，53 题不会撞
- **Anthropic Tier 1**（新账户）：50 RPM input + 5 RPM output。L1 53 题偶尔触发 retry，单题时间会涨。新账户头 24 小时内 tier 不会自动升级
- **Anthropic Tier 2+**：1000+ RPM，无感

撞到 limit 时 [`retry.ts`](../src/main/core/agent/retry.ts) 自动重试，跑得慢但不会失败。

---

## 工具子集（eval mode）

eval mode 不复用生产环境的 `buildAgentToolRegistry`（那个耦合 Electron IPC），自己组装一个精简 registry，定义在 [`tool-registry.ts`](../src/eval/gaia/tool-registry.ts)。

包含的工具：

| 工具组 | 包含 | 备注 |
|---|---|---|
| File ops | ✅ | `readFile` / `writeFile` / `listDirectory` / `runCommand` / 等。`runCommand` 在 eval mode 默认 allow（gate 在 user approval 上会破坏自动化） |
| `webFetch` | ✅ | 无需 key |
| `youtubeTranscript` | ✅ | 无需 key |
| `webSearch` | ✅ 仅当 `TAVILY_API_KEY` 已设 | |
| `webScrape` | ✅ 仅当 `FIRECRAWL_API_KEY` 已设 | |
| Document parsers | ✅ | `readPdfText` / `readDocxText` / `readXlsxSheet` / `readPptxSlides` / 等 |
| Interactive browser (`browserOpen`/`browserClick`/...) | ❌ | 需要 Electron runtime，Phase 3 解决 |
| GitHub / GitLab | ❌ | 需要 workspace SCM |
| `askClarification` | ❌ | 需要 IPC sender；eval mode 下出现等价于 fail |

GAIA 题如果需要不在列表里的工具，会被对应的 failure tag 标记（如 `attachment_not_processed`）。

---

## 跨运行 Diff Workflow

每次合 PR 后，跑同一份配置对比 baseline。

```bash
# 1. 第一次：建 baseline
pnpm gaia-eval \
  --dataset ~/datasets/gaia/2023/validation \
  --provider deepseek --model deepseek-chat --level 1 \
  --output ~/gaia-runs/baseline-2026-05-17

# 2. 合 PR 后再跑一份
pnpm gaia-eval \
  --dataset ~/datasets/gaia/2023/validation \
  --provider deepseek --model deepseek-chat --level 1 \
  --output ~/gaia-runs/after-pr-XXX

# 3. 对比
pnpm gaia-eval-diff \
  ~/gaia-runs/baseline-2026-05-17 \
  ~/gaia-runs/after-pr-XXX
```

生成的 `diff-vs-baseline.md` 包含：

- 准确率 / 各 level / 成本 / 中位耗时的 Δ
- **Newly passed**：baseline 失败、当前通过的题
- **⚠️ Regressions**：baseline 通过、当前失败的题（重点查）
- **Coverage drift**：两次 run 的题集不一致（如换了 `--limit` 或 `--level`）
- **Failure tag deltas**：按 \|Δ\| 排序

---

## 跑出第一份 baseline 之后

把 summary.json 几个关键字段贴出来分析：

```bash
cat ~/gaia-runs/baseline-2026-05-17/summary.json | jq '{
  accuracy,
  totals,
  byLevel,
  duration: { medianMs: .duration.medianMs, totalMin: (.duration.totalMs / 60000) },
  cost,
  failureTags
}'

# 失败模式分布（人读）
head -80 ~/gaia-runs/baseline-2026-05-17/failures.md

# 工具使用画像
cat ~/gaia-runs/baseline-2026-05-17/tool-usage.md
```

这三段就够决定下一步要补什么工具 / 调什么 prompt。

---

## 常见错误

### `ENOENT: metadata.jsonl`

旧版 loader bug —— 已修。需要 `git pull` 最新 main。新 loader 优先读 `metadata.parquet`，fallback 到 `metadata.jsonl`。

### `--api-key (or env GAIA_EVAL_API_KEY) is required`

env 没传到子进程。最稳的做法：
1. 在终端里 `export GAIA_EVAL_API_KEY=...`
2. **在同一个终端**里启动 Claude Code（如果用 Claude Code 跑）
3. 或者直接命令行加 `--api-key <key>`（不推荐，会进 shell history）

### `Authentication Fails`

key 错或对应账户没余额。各 provider 验证方法见 [Anthropic Console](https://console.anthropic.com)、[DeepSeek Platform](https://platform.deepseek.com) 等。

### 全部题都被 skipped

dataset 文件格式跟 loader 期待不匹配。检查 `<datasetDir>/metadata.parquet` 是不是真在那。HF 上 GAIA 现在用 parquet，不是 jsonl。

### Rate limit 撞太多

把 `--provider` 换成 deepseek 或换 `--model` 到 haiku。或者升级 Anthropic tier。

---

## 已知限制 / Phase 3 待做

- **没 Electron headless 支持** → interactive browser 工具（`browserOpen`/`browserClick`/...）无法在 eval mode 用，相关 L2/L3 题会 fail 在 `attachment_not_processed` 类 tag 下
- **并发硬编码为 1** → 单题串行执行，full L1 跑 30–60 分钟
- **没 HF leaderboard 提交格式** → 只能本地度量，不能发提交到 GAIA leaderboard
- **Resume 不支持** → 跑到一半 Ctrl-C 之后 summary.json 不会生成（已完成题的 `per-question/*.json` 还在）

跑完一份 baseline 后再回头讨论 Phase 3 优先级。

---

## 相关源码索引

| 文件 | 作用 |
|---|---|
| [`types.ts`](../src/eval/gaia/types.ts) | 所有 interface（GaiaQuestion, QuestionResult, RunSummary, FailureTag, ...） |
| [`dataset.ts`](../src/eval/gaia/dataset.ts) | Parquet / JSONL loader + 过滤 |
| [`scorer.ts`](../src/eval/gaia/scorer.ts) | 归一化 exact-match 评分 + FINAL ANSWER 抽取 + 数值前缀容忍（`tryLeadingNumber`）|
| [`workspace.ts`](../src/eval/gaia/workspace.ts) | 每题临时 `LocalWorkspace` + 附件复制 |
| [`tool-registry.ts`](../src/eval/gaia/tool-registry.ts) | eval mode 工具子集 |
| [`runner.ts`](../src/eval/gaia/runner.ts) | per-question 主循环 + summary 聚合 + report 落盘 |
| [`pricing.ts`](../src/eval/gaia/pricing.ts) | 模型价格表 |
| [`report.ts`](../src/eval/gaia/report.ts) | `failures.md` + `tool-usage.md` 生成 |
| [`diff.ts`](../src/eval/gaia/diff.ts) | 跨运行对比逻辑 |
| [`cli.ts`](../src/eval/gaia/cli.ts) | `gaia-eval` 入口（含 `--temperature` 解析）|
| [`../src/main/core/agent/reflection-gate.ts`](../src/main/core/agent/reflection-gate.ts) | 答案协议 retry rule（`missingFinalAnswer`）+ `forceNoTools` retry flag + LLM verifier hook。GAIA-specific 与 chat-path 共享，GAIA-specific rule 在 runner 里 compose |
| [`diff-cli.ts`](../src/eval/gaia/diff-cli.ts) | `gaia-eval-diff` 入口 |
