# gaia 脚本支持使用 Xiaomi MiMo 测试 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `pnpm gaia-eval --provider xiaomi` 成为 gaia 评测脚本的一等公民——补 HELP 文本、补 docs/gaia.md、跑一次端到端 smoke，验证 reasoning_content 链路打通。

**Architecture:** 不动 adapter 注册表与 runner（XiaomiAdapter 早已注册）。本计划只修改 (a) `src/eval/gaia/cli.ts` 的 HELP 字符串，(b) `docs/gaia.md` 的两处表格与新增的注意事项小节，(c) 跑一次 smoke 验证。MiMo 价格条目本轮不补，`summary.cost` 列保持 `—`。

**Tech Stack:** Node 18+ `util.parseArgs`、Vitest（已有的 gaia 单测）、`pnpm gaia-eval` CLI。

**Spec:** [docs/superpowers/specs/2026-05-27-gaia-xiaomi-mimo-design.md](../specs/2026-05-27-gaia-xiaomi-mimo-design.md)

---

## File Structure

| 文件 | 操作 | 责任 |
|---|---|---|
| `src/eval/gaia/cli.ts` | Modify (HELP 字符串，L39-69) | 让 `--help` 输出包含 xiaomi 选项与示例 |
| `docs/gaia.md` | Modify (L118、L306 前插入小节、L316 后追加行 + 脚注) | 让人读文档时能发现 xiaomi 支持，了解 base-url 必传与价格未收录 |

无新建文件、无单测改动、无 pricing.ts 改动。

---

## Task 1: 更新 CLI HELP 字符串

**Files:**
- Modify: `src/eval/gaia/cli.ts:43, 52, 63-68`

- [ ] **Step 1: 改 `--provider` 行（L43）**

用 `Edit`：

```
old_string:  --provider <name>       LLM provider: anthropic / openai / deepseek / minimax / custom
new_string:  --provider <name>       LLM provider: anthropic / openai / deepseek / minimax / xiaomi / custom
                          (xiaomi requires --base-url, e.g. https://api.xiaomimimo.com/v1)
```

- [ ] **Step 2: 改 `--base-url` 行（L52）**

用 `Edit`：

```
old_string:  --base-url <url>        Override provider endpoint (OpenAI-compatible providers)
new_string:  --base-url <url>        Override provider endpoint (OpenAI-compatible providers and xiaomi)
```

- [ ] **Step 3: 在 Example 块末尾追加 xiaomi 示例**

用 `Edit` 替换整个 Example 块。

old_string（注意结尾是反引号 + 分号 + 换行，必须精确）：

```
Example:
  pnpm gaia-eval \\
    --dataset ~/datasets/gaia/2023/validation \\
    --provider anthropic \\
    --model claude-sonnet-4-6 \\
    --level 1 --limit 5
`;
```

new_string：

```
Example:
  pnpm gaia-eval \\
    --dataset ~/datasets/gaia/2023/validation \\
    --provider anthropic \\
    --model claude-sonnet-4-6 \\
    --level 1 --limit 5

  pnpm gaia-eval \\
    --dataset ~/datasets/gaia/2023/validation \\
    --provider xiaomi \\
    --base-url https://api.xiaomimimo.com/v1 \\
    --model mimo-v2.5-pro \\
    --level 1 --limit 5
`;
```

- [ ] **Step 4: 验证 HELP 输出正确**

Run:
```bash
pnpm gaia-eval --help 2>&1 | head -45
```

Expected: 输出包含：
- 一行 `--provider <name>       LLM provider: anthropic / openai / deepseek / minimax / xiaomi / custom`
- 一行 `(xiaomi requires --base-url, e.g. https://api.xiaomimimo.com/v1)`
- 一行 `--base-url <url>        Override provider endpoint (OpenAI-compatible providers and xiaomi)`
- Example 块底部出现第二段 `--provider xiaomi ... --model mimo-v2.5-pro`

- [ ] **Step 5: TypeScript 类型检查**

Run:
```bash
pnpm tsc --noEmit
```

Expected: exit code 0，无类型错误。

- [ ] **Step 6: 跑 gaia 测试套件确认无回归**

Run:
```bash
pnpm vitest run src/eval/gaia/__tests__/
```

Expected: 所有测试 PASS（HELP 字符串改动不被任何测试断言）。

- [ ] **Step 7: Commit**

```bash
git add src/eval/gaia/cli.ts
git commit -m "$(printf 'feat(gaia): CLI HELP 支持 xiaomi provider\n\n--provider 行增列 xiaomi，并提示 --base-url 必传；--base-url 行扩\n描述至覆盖 xiaomi；Example 块追加一段 xiaomi + mimo-v2.5-pro 示例。\n\nCo-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>')"
```

---

## Task 2: 更新 docs/gaia.md

**Files:**
- Modify: `docs/gaia.md:118`（CLI 参数表）
- Modify: `docs/gaia.md:306` 之前（插入"Xiaomi MiMo 注意事项"小节）
- Modify: `docs/gaia.md:316-319`（成本表追加行 + 脚注）

- [ ] **Step 1: 更新 `--provider` 表格行（L118）**

用 `Edit`：

```
old_string:| `--provider <name>` | ✅ | — | `anthropic` / `openai` / `deepseek` / `minimax` / `custom` |
new_string:| `--provider <name>` | ✅ | — | `anthropic` / `openai` / `deepseek` / `minimax` / `xiaomi` / `custom` |
```

- [ ] **Step 2: 成本表格末尾追加 xiaomi 行**

用 `Edit`（anchor 是连续两行，确保唯一匹配）：

old_string:
```
| anthropic | `claude-opus-4-7` | 15 / 75 | ~$15–25 | 上限验证用 |
| openai | `gpt-4o` | 2.5 / 10 | ~$3–5 | OpenAI 标准 |
```

new_string:
```
| anthropic | `claude-opus-4-7` | 15 / 75 | ~$15–25 | 上限验证用 |
| openai | `gpt-4o` | 2.5 / 10 | ~$3–5 | OpenAI 标准 |
| xiaomi | `mimo-v2.5-pro` | — / — | — | reasoning 模型；价格表暂未收录，见下方脚注 |
```

- [ ] **Step 3: 在价格表硬编码说明之后插入 MiMo 脚注**

用 `Edit`：

old_string:
```
价格表硬编码在 [`pricing.ts`](../src/eval/gaia/pricing.ts) 的 `MODEL_PRICES`。新模型加一行即可。
```

new_string:
```
价格表硬编码在 [`pricing.ts`](../src/eval/gaia/pricing.ts) 的 `MODEL_PRICES`。新模型加一行即可。

> **MiMo 价格**：上表暂未收录 Xiaomi MiMo 的报价，`summary.json` 的 `cost` 列对 MiMo 行为 `—`。待官方报价稳定后回填 `src/eval/gaia/pricing.ts` 的 `MODEL_PRICES` 即可。
```

- [ ] **Step 4: 在「Provider 选型」之前插入「Xiaomi MiMo 注意事项」小节**

用 `Edit`：

old_string:
```
## Provider 选型
```

new_string:
```
## Xiaomi MiMo 注意事项

- `--base-url` 必传（如 `https://api.xiaomimimo.com/v1`），否则会落到 DeepSeek 默认 endpoint 认证失败。
- 模型 ID 形如 `mimo-v2.5-pro`、`mimo-v2.5`，token budget 已在 [`token-budget.ts`](../src/main/ai/token-budget.ts) 注册 128K 上下文。
- MiMo 要求 `reasoning_content` 在每一轮 assistant 消息中回传，[`xiaomi.ts`](../src/main/ai/adapters/xiaomi.ts) 的 fetch 拦截器自动维护，无需关心。
- 价格表暂未收录 MiMo，`summary.json` 的 `cost` 列会显示 `—`。

## Provider 选型
```

注：`## Provider 选型` 在文档里只出现一次（已 grep 确认），Edit 默认行为即可。

- [ ] **Step 5: 视觉检查渲染结果**

Run:
```bash
grep -nE "(xiaomi|MiMo|mimo)" docs/gaia.md
```

Expected: 至少 8 处命中：
- L118 provider 表格行（含 xiaomi）
- 新小节标题 `## Xiaomi MiMo 注意事项`
- 新小节内 4 个 bullet（含 mimo-v2.5-pro、mimo-v2.5、xiaomi.ts、reasoning_content）
- 成本表新增的 xiaomi 行
- MiMo 价格脚注

- [ ] **Step 6: Commit**

```bash
git add docs/gaia.md
git commit -m "$(printf 'docs(gaia): 文档支持 xiaomi MiMo provider\n\n- CLI 参数表 --provider 行增列 xiaomi\n- 成本对照表追加 mimo-v2.5-pro 行（cost 列 — / —）\n- 价格表后增 MiMo 价格脚注\n- 新增「Xiaomi MiMo 注意事项」小节，强调 --base-url 必传与\n  reasoning_content 自动维护\n\nCo-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>')"
```

---

## Task 3: 端到端 smoke 验证

**Files:** 无文件改动，跑命令收集输出。

**前置（用户已在对话中提供）：**
- baseUrl: `https://token-plan-sgp.xiaomimimo.com/v1`
- model: `mimo-v2.5-pro`
- apiKey: 通过环境变量传入，**绝不写进任何 commit 或文档**
- dataset: 用户本地 GAIA validation 目录路径（如果不存在，本任务可跳过 Step 2-4，仅做命令模板的 dry-check）

- [ ] **Step 1: 先看 `--help` 输出确认 Task 1 改动到位**

Run:
```bash
pnpm gaia-eval --help 2>&1 | tail -20
```

Expected: 末尾 Example 块有 xiaomi 示例（含 `--base-url https://api.xiaomimimo.com/v1` 与 `--model mimo-v2.5-pro`）。

- [ ] **Step 2: 检查 GAIA dataset 路径是否存在**

Run:
```bash
ls -d ~/datasets/gaia/2023/validation 2>/dev/null || ls -d ~/gaia/2023/validation 2>/dev/null || echo "GAIA_DATASET_NOT_FOUND — ask user for dataset path before Step 3"
```

如果输出 `GAIA_DATASET_NOT_FOUND`，停下来向用户索要 dataset 绝对路径，再继续。

- [ ] **Step 3: 跑 smoke（5 题，level 1）**

把下方 `<MIMO_API_KEY>` 替换为用户提供的 key（**不要落盘到任何文件**），`<GAIA_DATASET>` 替换为 Step 2 找到的路径，timeout 600s：

```bash
GAIA_EVAL_API_KEY='<MIMO_API_KEY>' \
pnpm gaia-eval \
  --smoke \
  --provider xiaomi \
  --model mimo-v2.5-pro \
  --base-url https://token-plan-sgp.xiaomimimo.com/v1 \
  --dataset <GAIA_DATASET> \
  --output /tmp/gaia-xiaomi-smoke 2>&1 | tee /tmp/gaia-xiaomi-smoke.log
```

Expected stdout 关键字（不要求 PASS 数——只要 adapter 链路打通）：
- 头部 `[gaia] dataset:  ...` `[gaia] level=1 limit=5 provider=xiaomi model=mimo-v2.5-pro temperature=0`
- 5 行 `[  N/5] ✓/✗ L1 ...`
- 尾部 `[gaia] done in ...` `[gaia] N/5 passed (accuracy ...)` `[gaia] summary: /tmp/gaia-xiaomi-smoke/summary.json`

**绝对不能出现的错误（出现即停，回到 spec 排查 XiaomiAdapter）：**
- `The reasoning_content in the thinking mode must be passed back to the API` — 拦截器没生效
- `401`/`403`/`Unauthorized` — key/baseUrl 错
- TypeScript 模块加载失败、未捕获异常

- [ ] **Step 4: 验证 summary.json 关键字段**

Run:
```bash
python3 -c "import json; d=json.load(open('/tmp/gaia-xiaomi-smoke/summary.json')); print(json.dumps({'config': d['config'], 'totals': d['totals'], 'accuracy': d['accuracy'], 'cost': d['cost']}, indent=2, ensure_ascii=False))"
```

Expected JSON 包含：
- `config.provider == "xiaomi"`
- `config.model == "mimo-v2.5-pro"`
- `totals.questions == 5`
- `cost.totalUsd == 0`（unpriced，符合预期）

- [ ] **Step 5: 抓 smoke 输出片段供 PR 描述用**

Run:
```bash
echo "=== 进度 ==="
grep -E "^\[ *[0-9]+/5\]" /tmp/gaia-xiaomi-smoke.log
echo ""
echo "=== 总结 ==="
grep -E "^\[gaia\]" /tmp/gaia-xiaomi-smoke.log | tail -10
echo ""
echo "=== summary 关键字段 ==="
python3 -c "import json; d=json.load(open('/tmp/gaia-xiaomi-smoke/summary.json')); print(json.dumps({'config': d['config'], 'totals': d['totals'], 'accuracy': d['accuracy'], 'cost': d['cost']}, indent=2, ensure_ascii=False))"
```

把整段输出留作 Task 4 PR 描述用。

- [ ] **Step 6: 留下 smoke 产物（不删，便于 PR review）**

Run:
```bash
ls -la /tmp/gaia-xiaomi-smoke/
```

Expected: `summary.json` / `per-question/` / `events/` / `failures.md` / `tool-usage.md` 齐全。**不 commit，不 push，纯本地工件。**

---

## Task 4: 开 PR

**Files:** 无文件改动。

- [ ] **Step 1: 检查所有 commit**

Run:
```bash
git log --oneline $(git merge-base HEAD main)..HEAD
git diff --stat $(git merge-base HEAD main)..HEAD
```

Expected: 至少 3 个 commit：
- spec（已在前一轮 brainstorming 后 commit；若未 commit 先补一次 `git add docs/superpowers/specs/2026-05-27-gaia-xiaomi-mimo-design.md && git commit`）
- cli.ts（Task 1 commit）
- docs/gaia.md（Task 2 commit）

diff stat 仅含上述 3 个文件 + 本 plan 文件本身（如果也 commit 了）。

- [ ] **Step 2: push 分支**

Run:
```bash
git push -u origin claude/gifted-hypatia-c91a86
```

- [ ] **Step 3: 开 PR**

Run（PR body 嵌入 Task 3 Step 5 抓的 smoke 输出，用 heredoc 防止 shell 转义）：

```bash
gh pr create --base main --head claude/gifted-hypatia-c91a86 \
  --title "feat(gaia): 脚本支持使用 Xiaomi MiMo 测试" \
  --body "$(cat <<'EOF'
## 背景

`XiaomiAdapter` 早已注册在 adapter registry，gaia runner 实际上能跑 `--provider xiaomi`，但 CLI HELP 与 `docs/gaia.md` 都没暴露。本 PR 把这条路径补完文档与示例，并通过端到端 smoke 验证 reasoning_content 链路。

详见 [设计文档](docs/superpowers/specs/2026-05-27-gaia-xiaomi-mimo-design.md) 与 [实施计划](docs/superpowers/plans/2026-05-27-gaia-xiaomi-mimo.md)。

## 改动

- `src/eval/gaia/cli.ts`：HELP 增列 xiaomi provider 与 mimo-v2.5-pro 示例
- `docs/gaia.md`：参数表 + 成本表追加 xiaomi 行，新增「Xiaomi MiMo 注意事项」小节
- **不改** `pricing.ts`：MiMo 价格留待官方稳定后回填，`summary.cost` 列暂显示 `—`

## Smoke 验证（mimo-v2.5-pro / token-plan-sgp.xiaomimimo.com）

```
<这里粘贴 Task 3 Step 5 的完整输出>
```

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 4: 验证 PR 已创建并报告 URL**

Run:
```bash
gh pr view --json url,number,title
```

Expected: 输出含 PR URL 与编号，title 是 `feat(gaia): 脚本支持使用 Xiaomi MiMo 测试`。把 URL 报给用户。

---

## Self-Review

- [ ] Spec coverage：
  - spec「改动清单 1」(cli.ts HELP) → Task 1 ✓
  - spec「改动清单 2」(docs/gaia.md) → Task 2 ✓
  - spec「改动清单 3」(pricing.ts 不改) → File Structure 表已声明 ✓
  - spec「改动清单 4」(smoke) → Task 3 ✓
  - spec「验收清单 5 项」→ Task 1 Step 5/6 + Task 2 Step 5 + Task 3 Step 3/4 全覆盖

- [ ] Placeholder scan：无 TBD / TODO / "implement later" / "handle edge cases" 等模糊词

- [ ] Type / 命名一致性：
  - env var 名 `GAIA_EVAL_API_KEY` 在 Task 3 Step 3 与 spec、cli.ts HELP 一致 ✓
  - flag 名 `--provider` / `--model` / `--base-url` / `--api-key` / `--smoke` / `--dataset` / `--output` 全程一致 ✓
  - model id `mimo-v2.5-pro` 与 spec 一致 ✓
  - baseUrl `https://token-plan-sgp.xiaomimimo.com/v1`（smoke 用户提供）与 HELP 文本举例 `https://api.xiaomimimo.com/v1`（通用示例）不冲突，刻意区分 ✓
