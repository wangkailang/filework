# Capability Eval Dataset

filework 的**确定性能力测试集** —— 10 道手写题，覆盖 L1 文件/数据处理类的核心能力。跟 [docs/gaia.md](./gaia.md) 共用同一个 runner，所以只是一个新的 `--dataset` 目录而已。

## 这是干嘛的

GAIA 偏研究/推理，题目宽泛、模型抽风波动大。capability 集解决两个具体问题：

1. **回归 sanity** —— 改 agent-loop / reflection-gate / tool-registry 之后，先跑 capability 确认没把基础能力打坏，再跑 GAIA。
2. **真正确定性** —— temp=0 时同一题应该 100% 答对，模型抖动不应该有借口。

10 道题，每道答案都被 [`__tests__/dataset.test.ts`](../src/eval/capability/__tests__/dataset.test.ts) 用纯 JS 验证过（fixture 内容确实蕴含 ground truth）。如果哪天有题挂了，**不是模型问题就是真回归**。

源码：[`src/eval/capability/`](../src/eval/capability/)

## 怎么跑

复用 GAIA 的 CLI，只是把 `--dataset` 指向 capability 目录：

```bash
pnpm gaia-eval \
  --dataset src/eval/capability/dataset \
  --provider deepseek \
  --model deepseek-chat \
  --level 1 \
  --output ~/cap-runs/$(date +%Y-%m-%d)
```

10 题，约 3–5 分钟（视 rate limit），DeepSeek 约 $0.01 以内。

跟现有 GAIA 一样，输出在 `--output` 下：

- `summary.json` —— 总体 accuracy + cost + quality metrics
- `per-question/*.json` —— 每题完整记录
- `events/*.jsonl` —— 每题事件流（可以喂给 `gaia-eval-replay`）

跨 run diff 和 trajectory replay 都直接复用：

```bash
pnpm gaia-eval-diff ~/cap-runs/baseline ~/cap-runs/current
pnpm gaia-eval-replay --batch ~/cap-runs/baseline ~/cap-runs/current
```

## 题目结构

每题在 [`dataset/metadata.jsonl`](../src/eval/capability/dataset/metadata.jsonl)，GAIA 格式：

| 字段 | 说明 |
|---|---|
| `task_id` | `cap-NNN-slug`，方便从 failure 报告反查 |
| `Question` | 给 agent 的提示，每题明确要求"只输出 X" |
| `Level` | 全部 `1`（capability 是 L1 sanity，不分级） |
| `Final answer` | 期望答案（scorer 走 normalise+exact match） |
| `file_name` | 附件文件名（空串 = 无附件，与 GAIA 一致） |

10 道题覆盖：

| ID | 能力 | 用到的工具（典型路径） |
|---|---|---|
| cap-001-md-h2 | markdown 结构解析 | readFile |
| cap-002-csv-rows | CSV 行计数 | readFile / runCommand wc |
| cap-003-numbers-sum | 数值聚合 | readFile + runCommand awk/python |
| cap-004-log-error-count | 日志过滤 | readFile / runCommand grep |
| cap-005-json-array-length | JSON 解析 | readFile / runCommand jq |
| cap-006-multiply | 纯算术（无附件） | runCommand python / 内嵌算 |
| cap-007-power-of-two | 纯算术（无附件） | runCommand python / 内嵌算 |
| cap-008-yaml-version | YAML key 抽取 | readFile / runCommand grep |
| cap-009-tsv-max | TSV 列聚合 | readFile + runCommand awk |
| cap-010-extension-count | 路径过滤 | readFile + runCommand grep |

## 加新题

1. 给 `metadata.jsonl` 加一行 `{"task_id":"cap-NNN-slug",...}`
2. 把附件（如果有）丢到 `dataset/<file_name>`
3. 在 `__tests__/dataset.test.ts` 的 `verifyAnswer` switch 里加一个 case，用纯 JS 验证答案能从 fixture 推出
4. `pnpm vitest run src/eval/capability` 应该全绿

第 3 步是关键 —— 没验证器的题不该加，否则就失去了确定性保证。
