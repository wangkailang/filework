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

- **Cancel workflow / pipeline**:M9 把 re-run 接进来了,但 cancel 还没;`/runs/:id/cancel` + `/pipelines/:id/cancel`。
- **workflow_dispatch**:GitHub 支持以 inputs 手动触发任意 workflow,目前 Agent 只能等被动触发;补齐后可主动 trigger 测试 workflow。
- **多行 review 范围 + dismiss/edit**:M10 只覆盖 review 的「创建」+「单行评论」;GitHub `start_line`+`line` 多行范围、`dismissReview` / `editReview` 留待后续。
- **GitLab MR Approve / Unapprove**:与 review 是分开的生命周期,M10 故意不做;独立工具补齐。
- **流式日志读取**:M9 现在 `await res.text()` 缓冲整段,百 MB 级日志需要换流式 reader。
- **Pagination cursor**:所有 list 接口在 100 条处截断,长尾仓库需要游标。
- **Background polling**:re-run 后 Agent 必须主动 `listCIRuns` 才能看到结果;后续考虑「CI 完成时主动推送 task-trace 事件」。

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
