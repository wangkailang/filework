# 设计：gaia 脚本支持使用 Xiaomi MiMo 测试

**日期**: 2026-05-27
**分支**: `claude/gifted-hypatia-c91a86`
**状态**: 待批准

## 背景与目标

`pnpm gaia-eval` 是项目的本地 GAIA 评测脚本。底层 LLM provider 注册表
[src/main/ai/adapters/index.ts](../../../src/main/ai/adapters/index.ts) **已经把 `XiaomiAdapter` 注册到
`xiaomi`**，且 `createModelWithAdapter` 已正确分发。理论上
`--provider xiaomi --base-url https://api.xiaomimimo.com/v1 --model mimo-v2.5-pro`
这条命令今天就能跑通。

但「能跑」≠「能用」。当前三处缺口让用户不知道也用不顺：

1. **CLI HELP 不列 `xiaomi`** — [src/eval/gaia/cli.ts:43](../../../src/eval/gaia/cli.ts) 只写
   `anthropic / openai / deepseek / minimax / custom`。
2. **`docs/gaia.md` 不提 `xiaomi`** — 同上，且没说 `reasoning_content` 自动维护这一点。
3. **MiMo 没列入价格表** — `cost.totalUsd` 会被算成 0（unpriced 行被滤掉），
   用户读 summary 容易误以为「免费」。

目标：让 Xiaomi MiMo 成为 gaia CLI 的一等 provider，包含**文档、HELP 文本、端到端 smoke 验证**；
价格条目本轮不补，留待官方报价稳定后回填。

## 决策摘要

| 维度 | 决策 |
|------|------|
| 改动面 | 只动 `src/eval/gaia/cli.ts` 的 HELP 字符串 + `docs/gaia.md` 的两处表格与一段注意事项 |
| 不动的地方 | XiaomiAdapter 本体、adapter registry、runner、reflection-gate、pricing.ts、单测 |
| `--base-url` 校验 | 不在 CLI 层做硬校验；HELP 文本明示「`xiaomi` 必须配 `--base-url`」，错误延迟到首个 fetch 浮出。与其它 OpenAI-compatible provider 行为一致 |
| MiMo 价格条目 | 本轮不加。`calculateCost` 继续返回 `null`，summary 的 cost 列显示 `—`。docs 加脚注说明 |
| 模型 ID | 文档示例用 `mimo-v2.5-pro`（128K context，已在 [token-budget.ts:54](../../../src/main/ai/token-budget.ts) 注册的前缀匹配里覆盖） |
| smoke 验证 | 用户提供 key/url/model/dataset，开发者在本地跑 `--smoke --provider xiaomi`，将 5 题结果与 summary 摘要贴进 PR 描述。**API key 通过 `GAIA_EVAL_API_KEY` 环境变量传入，不写进任何文件** |

## 改动清单

### 1. `src/eval/gaia/cli.ts` — 更新 HELP 字符串

**当前**：

```
--provider <name>       LLM provider: anthropic / openai / deepseek / minimax / custom
...
--base-url <url>        Override provider endpoint (OpenAI-compatible providers)
```

**改后**：

```
--provider <name>       LLM provider: anthropic / openai / deepseek / minimax / xiaomi / custom
                        (xiaomi requires --base-url, e.g. https://api.xiaomimimo.com/v1)
...
--base-url <url>        Override provider endpoint (OpenAI-compatible providers and xiaomi)
```

并在 Example 块下追加 xiaomi 的最小示例：

```
  pnpm gaia-eval \
    --dataset ~/datasets/gaia/2023/validation \
    --provider xiaomi \
    --base-url https://api.xiaomimimo.com/v1 \
    --model mimo-v2.5-pro \
    --level 1 --limit 5
```

### 2. `docs/gaia.md` — 表格与注意事项

**a) L118 `--provider` 行的 examples 列追加 `xiaomi`：**

```diff
- | `--provider <name>` | ✅ | — | `anthropic` / `openai` / `deepseek` / `minimax` / `custom` |
+ | `--provider <name>` | ✅ | — | `anthropic` / `openai` / `deepseek` / `minimax` / `xiaomi` / `custom` |
```

**b) 在「成本对照表」（约 L310-320）末尾追加一行：**

```diff
| anthropic | `claude-opus-4-7` | 15 / 75 | ~$15–25 | 上限验证用 |
+ | xiaomi | `mimo-v2.5-pro` | — / — | — | reasoning 模型；价格表暂未收录，见下方脚注 |
```

并在表下追加脚注：

> **MiMo 价格**：本表暂未收录 Xiaomi MiMo 的报价，`summary.json` 的 `cost` 列对 MiMo 行为 `—`。
> 待官方报价稳定后回填 `src/eval/gaia/pricing.ts` 的 `MODEL_PRICES` 即可。

**c) 在 Provider 行下方新增一个 3-4 行的小节：**

```markdown
### Xiaomi MiMo 注意事项

- `--base-url` 必传（如 `https://api.xiaomimimo.com/v1`），否则会落到 DeepSeek 默认 endpoint 认证失败。
- 模型 ID 形如 `mimo-v2.5-pro`、`mimo-v2.5`，token budget 已在 [token-budget.ts](../src/main/ai/token-budget.ts) 注册 128K 上下文。
- MiMo 要求 `reasoning_content` 在每一轮 assistant 消息中回传，[xiaomi.ts](../src/main/ai/adapters/xiaomi.ts) 的 fetch 拦截器自动维护，无需关心。
- 价格表暂未收录 MiMo，`summary.json` 的 cost 列会显示 `—`。
```

### 3. `src/eval/gaia/pricing.ts` — 不改

按"暂时不加价格条目"决策保持现状。`calculateCost('mimo-v2.5-pro', ...)` 返回 `null`，
[runner.ts:519-523](../../../src/eval/gaia/runner.ts) 已经把 `null` 滤掉再求和，summary 字段正常。

### 4. 端到端 smoke 验证（非代码改动）

命令模板（开发者本地执行，**key 通过环境变量**）：

```bash
GAIA_EVAL_API_KEY=<MIMO_API_KEY> \
pnpm gaia-eval \
  --smoke \
  --provider xiaomi \
  --model mimo-v2.5-pro \
  --base-url https://token-plan-sgp.xiaomimimo.com/v1 \
  --dataset ~/datasets/gaia/2023/validation
```

验收点：

- 5 题（L1）全部跑完，**未出现** `The reasoning_content in the thinking mode must be passed back to the API` 这类 400。
- `summary.json` 成功落盘，`cost.totalUsd` 为 0（unpriced），`config.provider === "xiaomi"`、`config.model === "mimo-v2.5-pro"`。
- 进度行能正常打印 `[1/5] ✓/✗ L1 ...` 5 行。

smoke 输出与 summary 摘要贴进 PR 描述。本设计不要求所有 5 题都 PASS——
adapter 链路打通即可，准确率不是本次目标。

## 不做的事（YAGNI）

- ❌ 不在 CLI 层加 `--provider` 白名单校验（保持与现有 provider 一致的"延迟报错"行为）。
- ❌ 不为 xiaomi 加硬性 `--base-url required` 校验（仅 HELP 文本中给出提示）。
- ❌ 不补 `pricing.ts` 与 `pricing.test.ts`（本轮不加价格）。
- ❌ 不动 `XiaomiAdapter` 本体、runner、reflection-gate、adapter registry。
- ❌ 不为 Xiaomi 加专门的 gaia 集成测试（adapter 已有 `xiaomi.test.ts`、`resolve-adapter-name.test.ts` 覆盖）。

## 风险与折中

| 风险 | 处理 |
|------|------|
| 用户漏传 `--base-url` 时落到 DeepSeek 默认 endpoint，错误信息不直观 | HELP 文本与 `docs/gaia.md` 注意事项节双重强调；不在 CLI 加硬校验以保持架构一致 |
| MiMo 价格缺失导致 `cost.totalUsd: 0` 被误读为「免费」 | docs 脚注明示「未收录、显示 `—`」；后续补价格只需改一个文件 |
| smoke 验证依赖用户提供 key/url/model/dataset | 用户已经一次性提供；通过环境变量传入，绝不写进文件 |
| MiMo 模型名变动（mimo-v2.5 → mimo-v3 等）| `token-budget.ts` 已用前缀匹配 `["mimo", 128_000]` 兜底；docs 示例只列已知 SKU |
| API key 已在对话中暴露 | smoke 跑完后建议用户到 Xiaomi 控制台轮换 |

## 验收清单

- [ ] `src/eval/gaia/cli.ts` HELP 字符串包含 `xiaomi`，并提示 `--base-url` 必传
- [ ] `docs/gaia.md` provider 表与成本表均出现 `xiaomi` 行；新增「Xiaomi MiMo 注意事项」小节
- [ ] `pnpm tsc --noEmit` 通过（HELP 改动是纯字符串，理论不影响类型）
- [ ] `pnpm test src/eval/gaia/__tests__/` 全部通过（不应受影响）
- [ ] 本地以用户提供的 MiMo key 跑 `--smoke` 成功，summary.json 写出，PR 描述附 5 行进度输出
