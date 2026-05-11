# 基于 PI 的改造

> 本文记录 filework 从「文件整理工具」演进为「通用 Workspace Agent」的过程,以及哪些设计直接借鉴自 [earendil-works/pi](https://github.com/earendil-works/pi)。所有改动均已合入 `main`,并按 M1 → M8 的顺序分批落地。

## 改造背景

filework 最初定位是 macOS 桌面端的本地 AI 文件助手,核心能力围绕「读目录、整理文件、解析 PDF/Excel」。在调研 PI 之后,我们发现:

- PI 把 **Workspace 抽象 + ToolRegistry + AgentLoop** 这三件事拆得很干净 → 任何「读 / 写 / 执行」的 Agent 都可以围绕这三件事重新组织。
- PI 的工作区可以是本地目录,也可以是 GitHub / GitLab 仓库的浅克隆 → Agent 不再被「桌面端 + 本地文件」绑定。
- PI 的工具调用走「类型化 SCM 方法 + 审批钩子」,而不是裸跑 `git push` → 安全性显著提升。

我们把这套思路移植到 filework,目标是:**保留原有的文件类技能,把底层 Agent 全部替换为通用、可托管远端仓库的实现**。

## 总览

| 里程碑 | 主题 | 关键 PR |
|---|---|---|
| **M1** | Workspace + ToolRegistry 基础设施 | #17 |
| **M2** | AgentLoop 接管所有工具调用 | #24, #26 |
| **M3** | 会话存储从 SQLite 迁到 JSONL | #23, #32 |
| **M5** | 品牌重塑为 "Workspace Agent" | #27 |
| **M6 PR 1** | GitHub Workspace 基础(浅克隆 + status/diff) | #28 |
| **M6 PR 2** | GitHub SCM 写操作 + 类型化 git 工具 | #29 |
| **M6 PR 3** | GitHub 原生查询 / 评论工具 | #30 |
| **M6 PR 4** | GitLab 提供方完全对等 | #31 |
| **M7** | GIT_ASKPASS + 凭证健康监控 | #33 |
| **M8** | CI / 流水线状态工具 | #34 |
| **M9** | CI 闭环 — 失败日志 + 重新运行 | #36 |
| **M10** | PR 行级评论 + 跨提供方 check 报告 | #38 |
| **M11** | CI 写面收尾 — Cancel + workflow_dispatch | #40 |
| **M12** | 后台 CI watcher — rerun 完成主动推送 | #42 |
| **M13** | Dispatch + watch — 补齐 M12 缺口 | #44 |
| **M14** | GitLab createPipeline + watch — 跨提供方主动触发 | #46 |
| **M15** | PR review 生命周期 — 多行评论范围 + dismiss + edit | #48 |
| **M16** | GitLab MR Approve / Unapprove + Approval rules | #50 |

> M4 主题被合并到 M5 一并发布,故无单独 PR。

## 借鉴自 PI 的核心设计

### 1. `Workspace` 抽象(M1)

**PI 思路**:Agent 操作的对象不是「磁盘路径」,而是一个 `Workspace` 接口,包含 `fs` / `exec` / 可选的 `scm`。

**filework 实现**:`src/main/core/workspace/types.ts`

```ts
export interface Workspace {
  readonly id: string;        // "local:/Users/kai/proj" 或 "github:org/repo@branch"
  readonly kind: WorkspaceKind;
  readonly root: string;
  readonly fs: WorkspaceFS;
  readonly exec: WorkspaceExec;
  readonly scm?: WorkspaceSCM;
}
```

三种实现:

- `LocalWorkspace` — 一个本地目录(原 filework 的等价物)。
- `GitHubWorkspace` — 通过浅克隆缓存到 `~/.filework/cache/github/`,FS / exec 走 `LocalWorkspace`,SCM 走 GitHub REST API。
- `GitLabWorkspace` — 与 GitHub 完全对等(包括自托管实例)。

`WorkspaceFS.toRelative()` 在所有实现里都强制路径必须落在 `root` 内,逃逸时抛 `WorkspaceEscapeError` —— 沿用了 PI 的「沙箱由 Workspace 自己保证,工具不需要重复检查」原则。

### 2. `ToolRegistry` + `AgentLoop`(M1, M2)

**PI 思路**:工具集中注册,执行时统一过 `beforeToolCall` 钩子做审批。

**filework 实现**:

- `src/main/core/agent/tool-registry.ts` — 工具定义、安全等级(`safe` / `destructive`)、统一执行入口。
- `src/main/core/agent/agent-loop.ts` — 唯一的 Agent 主循环,所有调用路径(IPC chat、fork-mode 子代理、plan-runner)都通过它。

M2 把旧的 `buildTools` / `wrapToolWithAbort` 等散落在 IPC 层的工具组装代码全部删掉,改为「工具一次注册,AgentLoop 统一调度」(详见 #24, #26)。

### 3. `WorkspaceSCM` 类型化方法(M6)

**PI 思路**:不要让 Agent 跑 `git push`,而是给它 `commit` / `push` / `openPullRequest` 这样的强类型方法,并且每个方法都是 `optional` —— 不同后端按需实现。

**filework 实现**:`WorkspaceSCM` 接口共暴露了三组能力:

| 组别 | 方法 | M6 PR |
|---|---|---|
| **状态读** | `status` / `diff` / `currentBranch` | PR 1 |
| **写操作** | `commit` / `push` / `openPullRequest` | PR 2 |
| **原生查询** | `listPullRequests` / `getPullRequest` / `listIssues` / `getIssue` / `commentIssue` / `commentPullRequest` / `searchCode` | PR 3 |

GitLab 的 MR(merge request)在内部全部投影到 vendor-neutral 的 `PullRequestSummary`(把 `iid` 映射为 `number`,`merged_at` 映射为 `state: "merged"`),Agent 看到的数据形状跨提供方一致。这一层投影(`Raw* → PullRequestSummary` 等)是 PI 没做的额外工作 —— PI 只支持单一提供方,我们一开始就需要双提供方对齐。

### 4. 类型化 git 工具 + `runCommand` 防火墙(M6 PR 2)

`gitCommit` / `gitPush` / `openPullRequest` 是显式的工具,**不允许** Agent 直接通过 `runCommand` 调用 `git push`。`looksLikeGitWrite` 在 GitHub / GitLab Workspace 的 exec 包装里拦截裸 git 写命令并返回 exit code 126,提示「请使用类型化工具」。

### 5. 审批流 + 白名单(M6 PR 2 起持续演进)

**PI 思路**:写操作必须经用户审批;`gitCommit` 等可在同一 task 内白名单化,`gitPush` / `openPullRequest` 这种「影响远端」的操作每次都要重新提示。

**filework 实现**:

- `src/main/ipc/approval-hook.ts` — 唯一的 `BeforeToolCallHook`,所有写操作必经此钩子。
- `src/main/ipc/ai-tools.ts:requestApproval` — 持有 `ALWAYS_PROMPT_TOOLS` 集合,`gitPush` / `openPullRequest` / `*CommentIssue` 等永不进入白名单。
- `writeFile` 在 plan 里被预批准的路径上自动放行;`moveFile` / `deleteFile` / `runCommand` 的 cwd 必须在 workspace 内。

### 6. JSONL 会话存储(M3)

**PI 思路**:对话记录走单文件 JSONL,而不是关系型数据库 —— 简化迁移、便于人工查看、Append-only 友好。

**filework 实现**:

- M3 PR 1 引入 `JsonlStore`,新会话默认写到 `~/.filework/sessions/<workspaceKey>/<sessionId>.jsonl`。
- M3 PR 2(在 GitHub PR 之前完成)把旧的 `chat_messages` / `chat_sessions` 等 SQLite 表彻底删除。SQLite 仍保留用于「凭证 / LLM 配置」这类需要随机读 + 更新的元数据。

### 7. GIT_ASKPASS 凭证保护(M7)

**问题**:M6 阶段我们曾把 token 直接拼进 clone URL(`https://oauth2:<token>@host/repo.git`),token 会落到 `.git/config` 里。

**解决**:M7 全面改造为 GIT_ASKPASS:

- `src/main/core/workspace/git-credentials.ts` — 启动时生成一个一次性 askpass shell 脚本,通过环境变量传 token 给 git。
- 每次 `push` / `fetch` 都会重写远程 URL 为「无 token 形式」,顺便清理 M7 之前留下的脏数据。
- 凭证健康监控(`src/main/ipc/credentials-monitor.ts`)在每次 App 启动后调度,对超过 24h 未测试的凭证发起健康检查并把结果落到 `credentials.testStatus` 列,UI 显示绿 / 红 / 灰三色状态点。

### 8. CI / 流水线感知(M8)

**PI 思路**:Agent 应当能感知 CI 状态,而不是把红色 PR 推给人去发现。

**filework 实现**:

- 新增三个可选的 vendor-neutral SCM 方法:`listCIRuns` / `getCIRun` / `listCIJobs`。GitHub 走 `/repos/.../actions/runs`,GitLab 走 `/projects/:id/pipelines`,统一投影为 `CIRunSummary` / `CIRunDetail` / `CIJobSummary`。
- 六个 `safety: "safe"` 工具:`githubListWorkflowRuns` / `githubGetWorkflowRun` / `githubListWorkflowRunJobs` 与 GitLab 同名兄弟,Agent 可以直接查询。
- **PR 前 CI 预检**:approval-hook 在 `openPullRequest` 调用前,先取当前分支的最近一次 CI 运行;如果是 `failure` / `cancelled`,通过新增的 `extraContext` 字段把警告文本带到审批卡上(琥珀色横幅)。失败查询(限流、过期 token、仓库未启用 Actions)被静默吞掉,从不阻塞用户。

GitLab pipeline 的 `failedSteps` 当前总是空数组 —— job-list 接口不暴露 step 状态,完整 trace 需要拉日志(已在 M9 补齐)。

### 9. CI 闭环 — 失败日志 + 重新运行(M9)

**PI 思路**:Agent 检测到 CI 失败之后,应当能直接读到原因(日志)并在修完后触发重跑,而不是把人留在循环里。

**filework 实现**:在 M8 的「能感知」之上把闭环扣住。

- 新增两个 vendor-neutral SCM 方法:
  - `getCIJobLog({jobId, lastLines?})` → `CIJobLog`(默认返回末尾 500 行,硬上限 5000;`truncated` 字段告诉模型「你看到的是尾部切片」)。
  - `rerunCI({runId, failedOnly?})` → 重新触发整个 run 或仅失败 jobs。
- 五个新工具:
  - `githubGetWorkflowJobLog`(safe)走 `/repos/.../actions/jobs/:jobId/logs`(text/plain)。
  - `githubRerunWorkflowRun`(destructive,全量重跑)/ `githubRerunFailedJobs`(destructive,仅失败重跑)。
  - `gitlabGetJobLog`(safe)走 `/projects/:id/jobs/:jobId/trace`。
  - `gitlabRetryPipeline`(destructive)走 `/projects/:id/pipelines/:id/retry` —— GitLab API 仅支持「失败重跑」,工具 schema 也不暴露 `failedOnly`,避免 Agent 误请求「全量重跑」。
- 三个 rerun 工具加入 `ALWAYS_PROMPT_TOOLS`:重跑会消耗 CI 额度并可能触发 deploy,与 `gitPush` / `openPullRequest` 同等级别 —— task 内不进白名单,每次都重新提示。
- 工程底层加了两个私有 helper:`ghText` / `glText` 处理 text/plain 响应;`ghPostNoBody` 处理 GitHub `/rerun*` 的 201-空 body 响应(避免 `.json()` 解析空字符串报错)。

闭环建立后,典型 Agent 流程变成:**发现红 CI → 拉失败 job 日志 → 诊断 → 推修复 → 触发重跑**,全程不离开聊天。

### 10. PR 行级评论 + 跨提供方 check 报告(M10)

**PI 思路**:Agent 既要能在 PR 里留下「针对某行代码」的可执行反馈,也要能在 merge 前看到 **所有** check 状态(不只是第一方 CI)。

**filework 实现**:

- 新增两个 vendor-neutral SCM 方法:
  - `reviewPullRequest({number, body?, comments?, event?})` → 一次提交 N 条行级评论 + 可选 summary body + 可选 verdict(`APPROVE` / `REQUEST_CHANGES` / `COMMENT`)。
  - `listCommitChecks({sha})` → 返回该 commit 的所有 check(GitHub Actions + 第三方如 CircleCI;GitLab statuses 也走同一抽象)。
- 四个新工具:
  - `githubReviewPullRequest`(destructive)走 `/repos/.../pulls/:n/reviews`,一次 POST 完成整个 review。
  - `githubListCommitChecks`(safe)走 `/commits/:sha/check-runs`,把 `app.slug` 投影成 `source` 字段(`github-actions` / `circleci` / …)。
  - `gitlabReviewMergeRequest`(destructive)先 GET MR detail 拿 `diff_refs`(base/head/start SHA),再依次 POST `/discussions`(每条行级评论)+ 可选 POST `/notes`(summary 正文)。**Schema 故意不暴露 `event`** —— GitLab 的 approve/unapprove 是单独 API,与 review 的语义不重叠,混在一起会让模型困惑。
  - `gitlabListCommitStatuses`(safe)走 `/repository/commits/:sha/statuses`,复用 M8 的 `mapPipelineStatus` 把 GitLab 状态映射成统一 `CIRunStatus` / `CIRunConclusion` union。
- 两个 review 工具加入 `ALWAYS_PROMPT_TOOLS`:行级评论是公开、难以撤销的内容,与 `commentPullRequest` / `openPullRequest` 同等级别。
- `RawMRDetail` 增加可选 `diff_refs?: { base_sha, head_sha, start_sha }` —— 加 GitLab review 必需。

GitLab 没有「review」的聚合对象;实现把第一条 discussion(或 summary note)的 id 作为 `reviewId` 返回,URL 指向那条 discussion。多行范围(GitHub 的 `start_line`+`line`)/ review 编辑 / dismiss 留待后续。

### 11. CI 写面收尾 — Cancel + workflow_dispatch(M11)

**PI 思路**:Agent 既要能停掉跑飞的 CI,也要能主动触发新 run(GitHub 的 workflow_dispatch),这样 CI 写面才完整。

**filework 实现**:在 M9 的 rerun 之上,把 cancel + dispatch 一起接进来。

- 三个新 vendor-neutral SCM 方法:
  - `cancelCI({runId})` → 取消进行中的 run / pipeline。两个提供方都实现。
  - `listWorkflows()` → `WorkflowSummary[]`,GitHub-only。Agent 在 dispatch 前用它查 `workflowFile` 候选。
  - `dispatchWorkflow({workflowFile, ref, inputs?})` → 用 inputs 手动触发 workflow_dispatch-enabled 的 workflow。GitHub-only。
- 四个新工具:
  - `githubCancelWorkflowRun`(destructive)走 `/runs/:id/cancel`。
  - `githubListWorkflows`(safe)走 `/actions/workflows`。
  - `githubDispatchWorkflow`(destructive)走 `/workflows/:id/dispatches`,URL-encode `workflowFile` 让 `.github/workflows/ci.yml` 这种 path 也能用。
  - `gitlabCancelPipeline`(destructive)走 `/pipelines/:id/cancel`。
- **不对称的审批策略**:cancel 工具**进白名单**(`gitCommit` 同级)—— cancel 是幂等的、只会减少 CI 活动;dispatch 工具**进 ALWAYS_PROMPT_TOOLS**(`gitPush` / rerun 同级)—— 起一个新 run、可能触发部署。`git-approval.test.ts` 有两个 regression guard 防止策略漂移。
- M9 的 `ghPostNoBody` 私有 helper 增加可选第三参数 `body?: unknown`,dispatch 借此传 `{ref, inputs}`。空 body 时跳过 `JSON.stringify(undefined)`(否则会被序列化为字面串 `"undefined"`),保持向后兼容。

GitLab 的 `dispatchWorkflow` / `listWorkflows` 故意不实现:GitLab 的 `POST /pipeline?ref=…` 是「在 ref 上创建一条新 pipeline」,与 GitHub 「以 inputs 手动触发某个声明了 workflow_dispatch 的 workflow」语义不同,值得单独的 SCM 方法(`createPipeline`)而不是混进 `dispatchWorkflow`。

收尾后,GitHub Actions 的 CI 写面三件套(trigger / re-trigger / cancel)Agent 都拥有。

### 12. 后台 CI watcher — rerun 完成主动推送(M12)

**PI 思路**:Agent 既然能触发 / 重跑 CI,就不应该再消耗 LLM token 去主动 `listCIRuns` 等结果。后台轮询应当在主进程发生,完成后主动推一条事件到 chat。

**filework 实现**:

- 新增主进程 watcher(`src/main/ipc/ci-watcher.ts`):一个模块级单例 `CiWatcher`,内部 `Map<watchKey, WatchEntry>`,`watchKey = ${workspace.id}:${runId}`。`subscribe({workspace, runId, sender, taskId, signal})` 启动 30s tick(`TICK_MS`)+ 5min 总超时(`TIMEOUT_MS`),`unsubscribe(watchKey)` 清理 timer / abort 监听。
- 每个 tick 调 `workspace.scm.getCIRun({id: runId})`:状态 `completed` 即推 `ai:ci-run-done` IPC 事件并自清;网络错误吞掉、保持订阅(下次 tick 再试);超时则推 `ai:ci-run-timeout` 自清。
- **触发策略**:`agent-tools.ts` 在工具注册时给 `githubRerunWorkflowRun` / `githubRerunFailedJobs` / `gitlabRetryPipeline` 套了一层 `maybeWrapWithWatcher`:`execute` 成功且返回 `{runId, queued: true}` 即自动调 `ciWatcher.subscribe`。Agent 不需要主动订阅。
- **dispatch 留作 M13**:GitHub `/dispatches` 返回 204 + 空 body,新 run 的 id 拿不到;watcher 没法用,需要后续做 `listCIRuns({ref, limit:1, status:in_progress})` 反查。
- `src/preload/index.ts` 加 `onCiRunDone` / `onCiRunTimeout`;`src/renderer/components/chat/useStreamSubscription.ts` 把事件追加为 `🔔` text part 到当前 task。`streamTaskIdRef` 不匹配则静默丢弃(用户已经走到下一个 task 时不污染那边的 chat)。
- **生命周期挂载**:tick 在 `sender.isDestroyed()` 或 `signal.aborted` 时自清;同 `${workspaceId}:${runId}` 重复 subscribe 自动 dedupe;状态全在内存,App 重启即丢(可接受,Agent 重新 list 即可恢复)。

闭环建立后,典型 Agent 流程变成:**触发 rerun → tool 返回 queued → 不再轮询 → 30s 周期主进程查 → 完成时 chat 主动 🔔**。

### 13. Dispatch + watch — 补齐 M12 缺口(M13)

**PI 思路**:M12 让 rerun 享受了「触发即被动等结果」的体验,但 dispatch 因为 GitHub `/dispatches` 返回 204+空 body、拿不到新 run id 而暂时缺席。补齐这块,Agent 对 rerun 与 dispatch 的体验就完全对称。

**filework 实现**:在 M12 的 watcher 上加一个小型 resolver。

- `src/main/ipc/ci-watcher.ts` 增加 `subscribeAfterDispatch({workspace, ref, workflowFile, sender, taskId, signal})`:对 `listCIRuns({ref, status:"in_progress", limit:1})` 最多 3 次重试,每次间隔 `RESOLVE_RETRY_MS = 2s`(总共 ~6s 预算),拿到第一个非空结果就 fall through 到 M12 的 `subscribe()`。导出常量是测试 seam,`vi.useFakeTimers` 可以确定性地 advance。
- 内部抽出 abort-aware `delay(ms, signal)` helper:`setTimeout` + `addEventListener("abort", ..., { once: true })`,任一先触发都 resolve 并清理另一边。让 task 取消时能立即停止重试循环、不浪费周期。
- `agent-tools.ts` 的 `maybeWrapWithWatcher` 拆成两支:`CI_WATCH_RERUN_TOOLS`(M12,直接 `subscribe`)和新的 `CI_WATCH_DISPATCH_TOOLS`(M13,fire-and-forget `void subscribeAfterDispatch`)。**fire-and-forget 是关键**:6s 重试预算如果 await,会卡住 tool 的 execute 返回。
- 失败 UX:resolve 用尽 3 次仍空,触发新事件 `ai:ci-dispatch-resolve-failed`(payload `{id, workspaceId, ref, workflowFile}`),renderer 把它渲染成一条 ⚠️ 文本 part:「已 dispatch <workflowFile> on <ref>,但未能识别新 run id (GitHub 可能尚未创建);可调用 `githubListWorkflowRuns` 手动查询。」让 Agent 与人都能 fall back 到手动 list。
- M12 里 `subscribe()` 已有的 `${workspaceId}:${runId}` dedupe 让 dispatch + rerun 的水流自然合并 —— 同一 runId 不会被两个 watcher 跟踪。

已知折中:同一 `ref` 上 6s 内有两个独立 dispatch,有可能选错 run。这种 race 在 Agent 主导的工作流里极少;退一步,M12 的 5min timeout 也是兜底。后续可考虑用 `event === "workflow_dispatch"` + 时间窗口二次过滤。

### 14. GitLab createPipeline + watch — 跨提供方主动触发(M14)

**PI 思路**:GitHub 早就能 dispatch + watch(M11/M13),GitLab 还差「主动起一条新 pipeline」这一块。补齐之后,跨提供方的「主动触发」就完全对称。

**filework 实现**:在 M12 的 watcher 上挂 GitLab 的 createPipeline 路径,**比 GitHub 更顺**:GitLab `POST /projects/:id/pipeline` 同步返回 pipeline JSON(含 id),Agent 立刻拿得到 runId,直接走 M12 的 `subscribe` —— 不需要 M13 的 `subscribeAfterDispatch` 重试 dance。

- `WorkspaceSCM` 增加 `createCIPipeline?({ref, variables?: Record<string,string>}): Promise<{runId, queued, ref}>`(M14)。GitHub 不实现(其等价物 `dispatchWorkflow` 走 M11/M13)。
- `gitlab-workspace.ts` 实现:`POST /projects/:id/pipeline` 带 body `{ref, variables}`,把 `Record<string,string>` 转成 GitLab 的 `[{key, value, variable_type:"env_var"}]` 数组。Agent 只看到字典 shape,转换在实现里。`variable_type:"env_var"` 硬编码,覆盖 >95% 用例;`"file"` 类型留待后续。
- 一个新工具:`gitlabCreatePipeline`(destructive)。Schema `{ref: string, variables?: Record<string,string>}`。Description 标注「GitLab pipeline 按 ref 上所有匹配 rules 的 job 跑,没有 GitHub 那种 per-workflow 过滤」。
- 加入 `ALWAYS_PROMPT_TOOLS`:起一个新 run + 可能 deploy,与 gitPush / dispatch / rerun 同级。审批文案:`在 <ref> 上创建 pipeline (N 个变量)`。
- `agent-tools.ts` 把 `CI_WATCH_RERUN_TOOLS` 改名为 `CI_WATCH_DIRECT_TOOLS`,因为这个 set 现在覆盖任何「同步返回 `{runId, queued}`」的工具(rerun + create-pipeline)。`gitlabCreatePipeline` 加入,M12 watcher 的同一段 wrapper 代码直接 subscribe。
- 已知折中:project 启用了 `workflow:rules` 排除该 ref 时,GitLab 返回 200 + 一条 status:`skipped` 的 pipeline。watcher 第一次 tick 就识别 → 推 `ai:ci-run-done` with `conclusion:"skipped"`,Agent 读到后判断。

经此一役,**跨提供方 CI 写面三件套(trigger / re-trigger / cancel)+ watcher** 在两边都全了。

### 15. PR review 生命周期 — 多行评论范围 + dismiss + edit(M15)

**PI 思路**:M10 让 Agent **创建** PR review 一次性的,但 review 是有生命周期的:多行 refactor 需要范围评论;判断错了要能撤回;summary 写错了要能改。补齐这块,GitHub 侧的 review 体验完整。

**filework 实现**:

- `PullRequestReviewComment` 加可选 `startLine?: number`(M15)。GitHub 映射成 `start_line` + `start_side:"RIGHT"`,与原有 `line` + `side` 并存。zod schema 用 `.refine(c.startLine === undefined || c.startLine < c.line)` 校验,失败给一句友好的「startLine must be < line」,不等到 GitHub 422。GitLab 侧 schema 不暴露 `startLine`(向 Agent 隐藏),SCM 实现也静默丢弃 —— 与 GitLab 已有的「忽略 `event` verdict」策略对齐。
- 两个新 vendor-neutral SCM 方法:
  - `dismissPullRequestReview?({number, reviewId, message})` → PUT `/pulls/:n/reviews/:id/dismissals`,body `{message, event:"DISMISS"}`。GitLab 不实现 —— M10 在 GitLab 侧是逐条 positional discussion 没有「review」聚合对象。
  - `editPullRequestReviewBody?({number, reviewId, body})` → PUT `/pulls/:n/reviews/:id`,body `{body}`。仅改 summary 不动 inline 评论。
- 两个新 GitHub 工具:`githubDismissReview`(destructive)+ `githubEditReviewBody`(destructive)。审批文案:`撤回 PR #N 的 review` / `编辑 PR #N 的 review summary`。
- 加入 `ALWAYS_PROMPT_TOOLS`:对外公开内容的 mutation,与 `commentPullRequest` / `reviewPullRequest` 同级,task 内不进白名单。
- 工程底层加了一个新私有 helper:`ghPut<T>(path, body, label?)`,镜像 `ghPost`。两个 lifecycle endpoints 都需要 body,不需要 `ghPutNoBody` 变种。

GitLab 侧的 review 生命周期(单条 discussion 的 edit/delete)留待后续 —— GitLab API 是 `PUT /projects/:id/merge_requests/:iid/discussions/:disc/notes/:note`,需要保留 discussion id + note id 的对应。M10 当时只回传第一条 discussion id 作为 `reviewId`,没存全集,补齐之前需要扩展 `reviewPullRequest` 的返回 shape。

### 16. GitLab MR Approve / Unapprove + Approval rules(M16)

**PI 思路**:M10 给 GitHub 装上了带 verdict 的 review(`reviewPullRequest({event:"APPROVE"})`),但 GitLab 上 Approve 是独立 endpoint —— 留个评论不等于「批准」。在启用了 approval rules 的 GitLab 项目里,Agent 留得了 inline 评论也写得了 summary,但**点不动那个解锁 merge 按钮的 Approve**。M16 把这块补齐,并保留两侧 API 的语义差异。

**filework 实现**:

- 新类型 `MergeRequestApprovalRule`(`types.ts`):窄投影 `{id, name, ruleType, approvalsRequired, eligibleApprovers}`,`eligibleApprovers` 只保留 username,丢掉 GitLab 完整对象里的 id / email / avatar 等噪音字段。
- 三个 GitLab-only 可选 SCM 方法:
  - `approveMergeRequest?({number})` → POST `/merge_requests/:iid/approve`,返回 `{number, approved:true}`。
  - `unapproveMergeRequest?({number})` → POST `/merge_requests/:iid/unapprove`,返回 `{number, approved:false}`。
  - `listMergeRequestApprovalRules?({number})` → GET `/merge_requests/:iid/approval_rules`,投影后返回。让 Agent 在投票前判断「我这一票能不能解锁 merge」。
- 三个 GitLab 工具:`gitlabApproveMergeRequest`(destructive)、`gitlabUnapproveMergeRequest`(destructive)、`gitlabListMergeRequestApprovalRules`(safe)。审批文案:`批准 (approve) MR !N` / `撤回批准 (unapprove) MR !N`。
- 加入 `ALWAYS_PROMPT_TOOLS`:Approve / Unapprove 是公开的投票信号,与 `commentMergeRequest` / `reviewMergeRequest` 同级,task 内不进白名单 —— 同一任务里反复 approve 也得每次弹卡。
- 工程底层加了一个新私有 helper:`glPostNoBody(path, body, label?)`,镜像 `ghPostNoBody`。GitLab `/approve` 与 `/unapprove` 在新版本返回 201/204 + 空 body,用 `glPost` 走 `res.json()` 会爆。

**关键决策**:

- **方法名为何用 `approveMergeRequest`,而不是 vendor-neutral 的 `approvePullRequest`?** GitHub 的 verdict 已经在 M10 的 `reviewPullRequest({event})` 里 ——把 GitLab 的 standalone Approve 折进去会把两套语义不同的 API 混淆。MR 名字本身就在提醒「这是 GitLab-only 的对称缺口」。
- **GitHub 侧不实现**:`reviewPullRequest({event:"APPROVE"})` 已经覆盖。新增 `approvePullRequest` 反而把 review-with-verdict 与 standalone-approve 两个语义模型搅在一起。
- **Approval rules 只读**:M16 只暴露 `listApprovalRules`,`createRule` / `editRule` / `deleteRule` 是项目管理员动作,频次低且权限重,不下放给 Agent。
- **「已批准过」错误如实抛出**:GitLab 在重复 approve 时返回 `401 You have already approved this merge request`,实现里不去捕获或包装,Agent 读到原文自己适配 —— 与 M9 「surface CI errors verbatim」一致。
- **PR review pending 状态不补**:M10/M15 一直是「创建即提交」;若 Agent 想协助提交人在 GitHub UI 创建的 pending review,需要单独工具,留待后续。

至此 GitHub / GitLab 两侧的 review-with-verdict 能力对齐(虽然走的是不同 SCM 方法),Agent 在 GitLab 启用 approval rules 的项目里可以完整完成「读规则 → 投票 → 必要时撤回」一整轮。

## 与 PI 的差异

| 维度 | PI | filework |
|---|---|---|
| **运行环境** | CLI 主导,可挂载远端 Workspace | 桌面 Electron App,本地 + 远端皆可 |
| **存储** | 文件系统(JSONL + 缓存克隆) | JSONL + SQLite(凭证 / 配置) |
| **审批** | TTY 交互式 | IPC 推送到渲染端,Confirmation 卡片 |
| **多提供方** | 通常单 GitHub | GitHub + GitLab 全部对等(含自托管) |
| **CI 接入** | 借助通用工具调用 | 类型化 SCM + 主动预检 |
| **凭证管理** | gh CLI / git credential helper | 加密存储 + askpass + 健康监控 |
| **i18n** | 英文为主 | 全量中英双语,审批文案中文 |
| **Skill 系统** | 不内置 | `.claude/skills/` 目录扫描 + fork-mode 子代理(继承 filework 原有的 Skill 体系) |

## 后续计划(暂未排期)

- **行级评论 edit / delete**:M15 只补了 review summary 的 edit + dismiss;单条 inline comment 的修改 / 删除 (GitHub `PATCH /pulls/comments/:id`、GitLab `PUT /discussions/:id/notes/:id`) 留待后续。
- **`submitPendingReview`**:M10/M15 都是「创建即提交」;若 Agent 想协助提交人在 GitHub UI 创建的 pending review,需要单独的工具。
- **dispatch 双 race 紧化匹配**:M13 默认 `{ref, status:in_progress, limit:1}` 取最新一条;同 ref 6s 内两个独立 dispatch 可能误选。后续按 `event === "workflow_dispatch"` + 时间窗口过滤。
- **流式日志读取**:M9 现在 `await res.text()` 缓冲整段,百 MB 级日志需要换流式 reader。
- **Pagination cursor**:所有 list 接口在 100 条处截断,长尾仓库需要游标。
- **CI 通知 JSONL 持久化 + 多窗口广播**:M12 watcher 事件只在「订阅时还活着」的 task 内可见;跨 task / 跨窗口的提醒留待后续。

## 参考文件索引

| 主题 | 路径 |
|---|---|
| Workspace 抽象 | `src/main/core/workspace/types.ts` |
| GitHub Workspace | `src/main/core/workspace/github-workspace.ts` |
| GitLab Workspace | `src/main/core/workspace/gitlab-workspace.ts` |
| askpass 凭证保护 | `src/main/core/workspace/git-credentials.ts` |
| ToolRegistry | `src/main/core/agent/tool-registry.ts` |
| AgentLoop | `src/main/core/agent/agent-loop.ts` |
| 审批钩子 | `src/main/ipc/approval-hook.ts` |
| 类型化 git 工具 | `src/main/core/agent/tools/git-tools.ts` |
| GitHub 原生工具 | `src/main/core/agent/tools/github-tools.ts` |
| GitLab 原生工具 | `src/main/core/agent/tools/gitlab-tools.ts` |
| JSONL 会话存储 | `src/main/core/session/jsonl-store.ts` |
| 凭证健康监控 | `src/main/ipc/credentials-monitor.ts` |
| ALWAYS_PROMPT_TOOLS / 审批描述 | `src/main/ipc/ai-tools.ts` |
| CI 后台 watcher | `src/main/ipc/ci-watcher.ts` |
