# 实现计划：AI Skills Runtime

## 概述

按模块逐步实现 AI Skills Runtime，从底层解析器开始，逐层向上构建发现、注册、预处理、执行、钩子和安全模块，最后与现有系统集成。每个模块实现后紧跟测试任务，确保增量验证。

## 任务

- [x] 1. 项目结构与核心类型定义
  - [x] 1.1 安装新依赖并创建目录结构
    - 安装生产依赖：`gray-matter`、`fast-glob`、`which`
    - 安装开发依赖：`fast-check`
    - 创建 `src/main/skills-runtime/` 目录及 `__tests__/` 子目录
    - _需求: 13.1_

  - [x] 1.2 定义核心类型与接口
    - 在 `src/main/skills-runtime/types.ts` 中定义 `SkillFrontmatter`、`ParsedSkill`、`DiscoverySource`、`DiscoveredSkill`、`UnifiedSkill`、`SkillTrustRecord`、`PreprocessResult` 等接口
    - `UnifiedSkill` 须为现有 `Skill` 接口的超集，增加 `external` 可选字段
    - 定义 `SkillParseError`、`SkillValidationError` 错误类
    - _需求: 1.1, 3.1, 3.2, 3.3_

- [x] 2. Parser 模块实现
  - [x] 2.1 实现 `parseSkillMd` 和 `printSkillMd` 函数
    - 在 `src/main/skills-runtime/parser.ts` 中实现
    - 使用 `gray-matter` 解析 YAML frontmatter
    - 无 frontmatter 时整个内容作为 body，frontmatter 使用空对象
    - `name` 字段验证：`/^[a-z0-9]+(-[a-z0-9]+)*$/` 且 `length <= 64`
    - 未识别字段忽略，空文件或读取失败返回 `SkillParseError`
    - _需求: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6_

  - [ ]* 2.2 编写 Parser 属性测试
    - [ ]* 2.2.1 Property 1: SKILL.md 解析/打印往返一致性
      - **属性 1: 往返一致性** — 对任意合法 `ParsedSkill`，`parseSkillMd(printSkillMd(skill))` 应与原始对象等价
      - **验证: 需求 1.1, 1.6, 1.7**
    - [ ]* 2.2.2 Property 2: 无 frontmatter 文件的默认值填充
      - **属性 2: 默认值填充** — 对任意不含 `---` 的 Markdown 字符串，解析后 body 等于原始字符串，frontmatter 为空对象
      - **验证: 需求 1.2**
    - [ ]* 2.2.3 Property 3: name 字段的 kebab-case 验证
      - **属性 3: name 验证** — 对任意字符串，仅 kebab-case 且长度 ≤ 64 时通过验证
      - **验证: 需求 1.3**
    - [ ]* 2.2.4 Property 4: 未识别 frontmatter 字段的容错性
      - **属性 4: 未识别字段容错** — 附加任意额外 YAML 字段不影响已知字段解析
      - **验证: 需求 1.4**

  - [ ]* 2.3 编写 Parser 单元测试
    - 在 `src/main/skills-runtime/__tests__/parser.test.ts` 中编写
    - 测试空文件错误（需求 1.5）、YAML 格式错误、特殊字符处理
    - _需求: 1.5_

- [x] 3. Discovery 模块实现
  - [x] 3.1 实现 `discoverSkills`、`buildDiscoverySources`、`checkEligibility` 函数
    - 在 `src/main/skills-runtime/discovery.ts` 中实现
    - 使用 `fast-glob` 递归扫描 `**/SKILL.md`
    - 构建默认发现源：个人目录 `~/.agents/skills/`、项目目录 `<workspace>/.agents/skills/`、附加目录
    - 优先级：project > personal（同名技能项目级覆盖个人级）
    - 目录不存在时静默跳过（`fs.access` 检查）
    - 资格检查：使用 `which` 检查 `requires.bins`，检查 `process.env` 中 `requires.env`，检查 `process.platform` 匹配 `requires.os`
    - 不合格技能标记 `eligible: false`，记录 debug 日志
    - _需求: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 9.1, 9.2, 9.3, 9.4, 9.5, 9.6_

  - [ ]* 3.2 编写 Discovery 属性测试
    - [ ]* 3.2.1 Property 5: 多路径技能发现完整性
      - **属性 5: 发现完整性** — 对任意包含 SKILL.md 的目录树，发现的技能数量等于 SKILL.md 文件数量
      - **验证: 需求 2.1, 2.2, 2.3, 2.5**
    - [ ]* 3.2.2 Property 6: 项目级技能覆盖个人级同名技能
      - **属性 6: 项目覆盖个人** — 同名技能同时存在时，注册表中该名称对应技能来自项目目录
      - **验证: 需求 2.4**
    - [ ]* 3.2.3 Property 16: 资格检查排除不合格技能
      - **属性 16: bins 资格检查** — 当指定二进制不在 PATH 中时，技能标记为不合格
      - **验证: 需求 9.1, 9.2, 9.6, 9.7**
    - [ ]* 3.2.4 Property 17: 资格检查环境变量验证
      - **属性 17: env 资格检查** — 当指定环境变量未设置时，技能标记为不合格
      - **验证: 需求 9.3, 9.4**

  - [ ]* 3.3 编写 Discovery 单元测试
    - 在 `src/main/skills-runtime/__tests__/discovery.test.ts` 中编写
    - 测试目录不存在跳过（需求 2.6）、工作区切换重新发现（需求 2.7）、OS 不匹配（需求 9.5）、不合格技能静默排除（需求 9.6, 9.7）
    - _需求: 2.6, 2.7, 9.5, 9.6, 9.7_

- [x] 4. 检查点 — 确保所有测试通过
  - 确保所有测试通过，如有问题请询问用户。

- [x] 5. Security 模块实现
  - [x] 5.1 实现安全控制函数
    - 在 `src/main/skills-runtime/security.ts` 中实现
    - 实现 `computeSkillHash`：计算 SKILL.md + hooks 脚本的 SHA-256 哈希
    - 实现 `isSkillTrusted`：检查技能是否已获信任（比对存储的哈希）
    - 实现 `requestSkillApproval`：通过 IPC 向渲染进程发送审批请求
    - 实现 `buildSafeEnv`：过滤敏感环境变量（`*_API_KEY`、`*_SECRET`、`*_TOKEN`、`*_PASSWORD`）
    - 实现 `isCommandAllowed`：命令白名单/黑名单检查，定义 `SAFE_COMMAND_PREFIXES` 和 `BLOCKED_COMMAND_PREFIXES`
    - 实现来源信任分级逻辑（high/medium/low）
    - _需求: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6_

  - [ ]* 5.2 编写 Security 属性测试
    - [ ]* 5.2.1 Property 20: 内容哈希变化触发重新审批
      - **属性 20: 哈希变化重新审批** — 已获信任技能内容变化后，`isSkillTrusted` 返回 `false`
      - **验证: 需求 12.3**
    - [ ]* 5.2.2 Property 21: 环境变量过滤完整性
      - **属性 21: 环境变量过滤** — `buildSafeEnv` 返回结果不包含任何匹配敏感模式的变量
      - **验证: 需求 12.4**
    - [ ]* 5.2.3 Property 22: 命令白名单/黑名单一致性
      - **属性 22: 命令白/黑名单** — 黑名单命令始终返回 `false`，白名单命令在 high/medium 信任级别下返回 `true`
      - **验证: 需求 12.5**

  - [ ]* 5.3 编写 Security 单元测试
    - 在 `src/main/skills-runtime/__tests__/security.test.ts` 中编写
    - 测试首次审批流程、哈希校验与篡改检测、来源信任分级、prompt injection 边界标记、低信任来源禁用 hooks（需求 12.6）
    - _需求: 12.1, 12.2, 12.3, 12.5, 12.6, 12.7_

- [x] 6. Skill Registry 模块实现
  - [x] 6.1 实现 `SkillRegistry` 类
    - 在 `src/main/skills-runtime/registry.ts` 中实现
    - 实现 `registerBuiltIn`：注册内置技能
    - 实现 `registerExternal`：注册外部技能（仅合格技能），保留 `DiscoverySource` 和 `Priority_Order`
    - 实现 `refreshProjectSkills`：工作区切换时刷新项目级技能
    - 实现 `getById`：通过 ID 获取技能
    - 实现 `matchByCommand`：通过 `/command` 名称匹配技能
    - 实现 `matchByPrompt`：统一匹配流程（内置 keyword + 外部 description），`disable-model-invocation: true` 的技能跳过
    - 实现 `listUserVisible`：排除 `user-invocable: false` 的技能
    - 实现 `listAll`：完整技能列表（IPC 用）
    - 外部技能 ID 规则：frontmatter.name 优先，否则使用目录名
    - _需求: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 5.1, 5.2, 5.4_

  - [ ]* 6.2 编写 Registry 属性测试
    - [ ]* 6.2.1 Property 7: 注册表统一管理与元数据保留
      - **属性 7: 统一管理** — 所有注册技能可通过 `getById` 检索，外部技能元数据完整保留
      - **验证: 需求 3.1, 3.3**
    - [ ]* 6.2.2 Property 8: 技能标识符唯一性与派生规则
      - **属性 8: ID 唯一性** — 外部技能 ID 等于 frontmatter.name 或目录名，注册表中无重复 ID
      - **验证: 需求 3.2**
    - [ ]* 6.2.3 Property 9: disable-model-invocation 排除自动匹配
      - **属性 9: 排除自动匹配** — `disable-model-invocation: true` 的技能永远不会被 `matchByPrompt` 返回
      - **验证: 需求 3.5, 5.4**
    - [ ]* 6.2.4 Property 10: user-invocable 过滤用户可见列表
      - **属性 10: 用户可见过滤** — `user-invocable: false` 的技能不出现在 `listUserVisible` 结果中
      - **验证: 需求 3.6**
    - [ ]* 6.2.5 Property 13: 统一匹配流程
      - **属性 13: 统一匹配** — `matchByPrompt` 在统一评分后返回最高分技能，不区分来源类型
      - **验证: 需求 5.1, 5.2, 5.3**

  - [ ]* 6.3 编写 Registry 单元测试
    - 在 `src/main/skills-runtime/__tests__/registry.test.ts` 中编写
    - 测试 IPC 技能列表格式（需求 3.4）、重复 ID 冲突处理
    - _需求: 3.4_

- [x] 7. Preprocessor 模块实现
  - [x] 7.1 实现 `preprocessSkill` 函数
    - 在 `src/main/skills-runtime/preprocessor.ts` 中实现
    - 按顺序处理：`$ARGUMENTS` → `$ARGUMENTS[N]`/`$N` → `!command` → 截断检查
    - `$ARGUMENTS` 替换为完整参数字符串
    - `$ARGUMENTS[N]`/`$N` 替换为按空格分割的第 N 个参数，索引越界替换为空字符串
    - `!command` 在 `workspacePath` 目录下执行，默认超时 10 秒
    - `!command` 执行前调用 `security.isCommandAllowed` 检查命令合法性
    - `!command` 执行时使用 `security.buildSafeEnv` 过滤环境变量
    - 失败时替换为 `[Error: command failed: <reason>]`，超时替换为 `[Error: command timed out after Xs]`
    - 截断检查：超过 `maxChars`（默认 20000）时截断并追加 `[...truncated, read full content from: <sourcePath>]`
    - _需求: 4.4, 4.5, 6.1, 6.2, 6.3, 6.4, 6.5, 11.1, 11.2, 11.3, 11.4_

  - [ ]* 7.2 编写 Preprocessor 属性测试
    - [ ]* 7.2.1 Property 11: /command 命令匹配与参数提取
      - **属性 11: 命令匹配** — 输入 `/skill-id args` 时匹配对应技能并正确提取参数
      - **验证: 需求 4.2, 4.3**
    - [ ]* 7.2.2 Property 12: $ARGUMENTS 参数替换完整性
      - **属性 12: 参数替换** — 预处理后不再包含未替换的占位符
      - **验证: 需求 4.4, 4.5**
    - [ ]* 7.2.3 Property 14: !command 动态上下文替换
      - **属性 14: !command 替换** — 命令成功时替换为 stdout，结果中不再包含 `!command` 语法
      - **验证: 需求 6.1, 6.2**
    - [ ]* 7.2.4 Property 18: 截断保留路径信息
      - **属性 18: 截断保留路径** — 超过限制的正文截断后包含原始文件路径
      - **验证: 需求 11.2, 11.3**

  - [ ]* 7.3 编写 Preprocessor 单元测试
    - 在 `src/main/skills-runtime/__tests__/preprocessor.test.ts` 中编写
    - 测试命令未匹配提示（需求 4.6）、!command 超时（需求 6.5）、!command 失败（需求 6.3）、截断标记格式（需求 11.2）、可配置截断上限（需求 11.4）
    - _需求: 4.6, 6.3, 6.5, 11.2, 11.4_

- [x] 8. 检查点 — 确保所有测试通过
  - 确保所有测试通过，如有问题请询问用户。

- [x] 9. Hooks 模块实现
  - [x] 9.1 实现 `runHook` 函数
    - 在 `src/main/skills-runtime/hooks.ts` 中实现
    - 钩子脚本路径相对于技能目录解析
    - 在工作区根目录上下文中执行
    - 失败时记录日志但不中断主流程
    - 默认超时 30 秒
    - _需求: 8.1, 8.2, 8.3, 8.4_

  - [ ]* 9.2 编写 Hooks 单元测试
    - 在 `src/main/skills-runtime/__tests__/hooks.test.ts` 中编写
    - 测试钩子执行顺序（需求 8.1-8.3）、钩子失败不中断（需求 8.4）
    - _需求: 8.1, 8.2, 8.3, 8.4_

- [x] 10. Executor 模块实现
  - [x] 10.1 实现 `executeSkill`、`executeSubagent`、`buildSkillCatalogXml` 函数
    - 在 `src/main/skills-runtime/executor.ts` 中实现
    - `executeSkill`：根据 `context` 字段选择默认模式或 fork 模式
    - 默认模式：将预处理后的技能正文注入 system prompt，调用现有 `streamText`
    - fork 模式：创建独立 `streamText` 调用，`allowed-tools` 指定的工具使用 `rawExecutors`（无审批），`model` 字段覆盖时创建指定模型
    - 在技能正文注入前追加安全边界标记（prompt injection 缓解）
    - 执行前调用 `hooks.runHook` 执行 pre-activate 钩子
    - 执行后调用 `hooks.runHook` 执行 post-complete 钩子
    - `buildSkillCatalogXml`：生成 `<available_skills>` XML 目录块
    - Eager/Lazy 模式切换：默认 Eager，外部技能数量超过阈值（默认 10）时自动切换 Lazy
    - Lazy 模式下注入紧凑目录块，模型通过 readFile 按需读取
    - 执行结果通过现有流式事件通道返回渲染进程
    - _需求: 5.3, 7.1, 7.2, 7.3, 7.4, 7.5, 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 12.7_

  - [ ]* 10.2 编写 Executor 属性测试
    - [ ]* 10.2.1 Property 15: allowed-tools 工具过滤
      - **属性 15: 工具过滤** — fork 模式下可用工具集恰好等于 `allowed-tools` 列表
      - **验证: 需求 7.3**
    - [ ]* 10.2.2 Property 19: Lazy Loading 目录完整性
      - **属性 19: Lazy Loading 目录** — 生成的目录块包含每个合格技能的 name、description、location
      - **验证: 需求 10.3, 10.6**

  - [ ]* 10.3 编写 Executor 单元测试
    - 在 `src/main/skills-runtime/__tests__/executor.test.ts` 中编写
    - 测试 fork 模式触发（需求 7.1）、model 覆盖（需求 7.4）、流式输出集成（需求 7.5）、Eager/Lazy 模式切换（需求 10.1-10.5）
    - _需求: 7.1, 7.4, 7.5, 10.1, 10.2, 10.3, 10.4, 10.5_

- [x] 11. 与现有系统集成 — 主进程
  - [x] 11.1 更新技能类型与注册入口
    - 更新 `src/main/skills/types.ts`，确保 `Skill` 接口与 `UnifiedSkill` 兼容（或导出适配器函数）
    - 更新 `src/main/skills/index.ts`，将静态 `skills` 数组注册到 `SkillRegistry`，导出 `SkillRegistry` 单例
    - 替换 `getSkill`、`matchSkill`、`getAllSuggestions` 为 `SkillRegistry` 的对应方法
    - _需求: 3.1, 13.1_

  - [x] 11.2 更新 AI Handlers 集成技能运行时
    - 更新 `src/main/ipc/ai-handlers.ts`
    - 在 `ai:executeTask` 处理流程中插入技能解析与预处理逻辑
    - 检测 `/skill-name` 命令格式，调用 `registry.matchByCommand`
    - 普通提示调用 `registry.matchByPrompt` 进行自动匹配
    - 匹配到技能后调用 `preprocessor.preprocessSkill` 预处理
    - 根据技能 `context` 字段选择默认注入或 Subagent fork 执行
    - 未匹配到技能时保持默认行为
    - 复用现有 `streamText` 管线和工具审批机制
    - _需求: 4.1, 4.2, 4.3, 4.6, 5.1, 5.2, 5.3, 13.1, 13.2, 13.4_

  - [x] 11.3 添加技能列表 IPC 通道
    - 在 `src/main/ipc/ai-handlers.ts` 中注册新的 IPC handler（如 `ai:listSkills`）
    - 返回 `registry.listUserVisible()` 的技能列表（名称、描述、来源类型）
    - _需求: 3.4, 13.3_

  - [x] 11.4 初始化技能发现与注册流程
    - 在应用启动时调用 `buildDiscoverySources` 和 `discoverSkills` 扫描技能
    - 将内置技能和合格外部技能注册到 `SkillRegistry`
    - 工作区切换时调用 `refreshProjectSkills` 刷新项目级技能
    - _需求: 2.1, 2.2, 2.7, 9.7_

- [x] 12. 与现有系统集成 — 预加载与渲染进程
  - [x] 12.1 更新 preload IPC 桥接
    - 更新 `src/preload/index.ts`，暴露新的 IPC 方法（如 `listSkills`、`approveSkill`）
    - _需求: 13.3_

  - [x] 12.2 更新渲染进程 — 技能选择菜单与 `/` 命令
    - 更新 `src/renderer/components/chat/ChatPanel.tsx` 或相关组件
    - 用户输入 `/` 时显示可调用技能列表（调用 `listSkills` IPC）
    - 选择技能后以 `/skill-name` 格式发送
    - 未匹配到技能时显示提示信息
    - _需求: 4.1, 4.6_

  - [x] 12.3 更新渲染进程 — 技能激活状态显示
    - 在聊天界面中显示当前激活的技能名称和来源
    - 通过流式事件通道接收技能激活信息
    - _需求: 13.5_

  - [x] 12.4 更新渲染进程 — 技能审批弹窗
    - 实现技能审批 UI 组件，展示技能名称、来源、将执行的命令和 hooks 脚本
    - 用户确认或拒绝后通过 IPC 返回结果
    - _需求: 12.1_

- [ ] 13. 集成测试
  - [ ]* 13.1 编写集成测试
    - 在 `src/main/skills-runtime/__tests__/` 中编写集成测试
    - 测试 streamText 复用（需求 13.1）、工具审批复用（需求 13.2）、IPC 通信（需求 13.3, 13.4）、技能名称显示（需求 13.5）
    - 测试完整流程：发现 → 解析 → 注册 → 匹配 → 预处理 → 执行
    - _需求: 13.1, 13.2, 13.3, 13.4, 13.5_

- [x] 14. 最终检查点 — 确保所有测试通过
  - 确保所有测试通过，如有问题请询问用户。

## 备注

- 标记 `*` 的任务为可选任务，可跳过以加速 MVP 交付
- 每个任务引用了具体的需求编号以确保可追溯性
- 检查点任务确保增量验证
- 属性测试验证普遍正确性属性，单元测试验证具体示例和边界情况
- 所有 22 个正确性属性均已覆盖在属性测试子任务中
