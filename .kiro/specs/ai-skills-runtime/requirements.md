# 需求文档：AI Skills Runtime

## 简介

AI Skills Runtime 为 FileWork 桌面应用引入对 Agent Skills 开放标准规范的支持。该运行时能够从多个位置发现、解析并执行以 `SKILL.md` 为入口的技能目录，使用户和 AI 均可通过标准化方式调用技能。该功能将与现有的内置技能系统共存，并复用现有的 AI 执行管线（Vercel AI SDK、工具审批、流式输出）。

## 术语表

- **Runtime**: AI Skills Runtime 模块，负责技能的发现、解析、注册与执行
- **Skill_Directory**: 包含 `SKILL.md` 入口文件及可选支撑文件的目录
- **SKILL_MD**: 技能目录中的 `SKILL.md` 文件，包含 YAML frontmatter 和 Markdown 正文
- **Frontmatter**: `SKILL.md` 文件顶部的 YAML 元数据块，定义技能的配置属性
- **Skill_Registry**: 统一管理内置技能与外部技能的注册表
- **Discovery_Source**: 技能的来源位置，包括个人目录（`~/.agents/skills/`）、项目目录（`.agents/skills/`）和附加目录
- **Priority_Order**: 技能发现的优先级顺序：个人级 > 项目级（项目级可覆盖个人级同名技能）
- **Invocation_Command**: 用户通过 `/skill-name` 或 `/skill-name arguments` 格式调用技能的命令
- **Dynamic_Context**: 使用 `!command` 语法在技能内容发送给 AI 前执行 shell 命令并注入输出结果
- **Subagent**: 当技能配置 `context: fork` 时，在隔离上下文中执行技能的子代理
- **Built_In_Skill**: 现有的以 TypeScript 对象形式定义的内置技能（如 file-organizer、pdf-processor）
- **Parser**: 负责读取和解析 `SKILL.md` 文件的解析器模块
- **Printer**: 负责将解析后的技能数据结构格式化输出为合法 `SKILL.md` 文件的模块
- **Eligibility_Check**: 技能加载时的资格检查，验证技能声明的依赖（二进制、环境变量、操作系统）是否满足
- **Lazy_Loading**: 延迟加载模式，仅在系统提示中注入技能目录摘要，模型按需读取完整技能内容
- **Eager_Injection**: 即时注入模式，匹配到技能后直接将完整正文注入系统提示
- **Truncation_Limit**: 技能正文注入到上下文时的最大字符数上限，超出部分截断并标记

## 需求

### 需求 1：SKILL.md 解析

**用户故事：** 作为开发者，我希望系统能解析 SKILL.md 文件，以便将技能定义转化为可执行的数据结构。

#### 验收标准

1. WHEN 提供一个包含合法 YAML frontmatter 和 Markdown 正文的 SKILL.md 文件时，THE Parser SHALL 将其解析为包含 frontmatter 字段和正文内容的 Skill 数据结构
2. WHEN SKILL.md 文件缺少 YAML frontmatter 时，THE Parser SHALL 将整个文件内容作为技能正文，并使用默认值填充 frontmatter 字段
3. WHEN SKILL.md 的 frontmatter 包含 `name` 字段时，THE Parser SHALL 验证该值为 kebab-case 格式且长度不超过 64 个字符
4. WHEN SKILL.md 的 frontmatter 包含无法识别的字段时，THE Parser SHALL 忽略该字段并继续解析
5. IF SKILL.md 文件内容为空或无法读取，THEN THE Parser SHALL 返回包含文件路径和错误原因的描述性错误
6. THE Printer SHALL 将 Skill 数据结构格式化输出为合法的 SKILL.md 文件内容（YAML frontmatter + Markdown 正文）
7. FOR ALL 合法的 Skill 数据结构，解析后打印再解析 SHALL 产生等价的对象（往返一致性）

### 需求 2：技能发现

**用户故事：** 作为用户，我希望系统能自动从多个位置发现技能，以便我可以在个人目录和项目目录中管理技能。

#### 验收标准

1. THE Runtime SHALL 从个人目录（`~/.agents/skills/`）扫描并发现所有包含 `SKILL.md` 的子目录
2. WHEN 用户打开一个工作区时，THE Runtime SHALL 从项目目录（`<workspace>/.agents/skills/`）扫描并发现所有包含 `SKILL.md` 的子目录
3. THE Runtime SHALL 递归扫描技能目录的嵌套子目录以支持 monorepo 结构
4. WHEN 个人目录和项目目录中存在同名技能时，THE Runtime SHALL 以项目级技能覆盖个人级技能
5. WHEN 通过附加目录参数指定额外路径时，THE Runtime SHALL 从该路径扫描并发现技能
6. IF 技能目录不存在或无法访问，THEN THE Runtime SHALL 跳过该目录并继续扫描其他位置，不产生致命错误
7. WHEN 工作区路径发生变化时，THE Runtime SHALL 重新执行项目级技能的发现流程

### 需求 3：技能注册与统一管理

**用户故事：** 作为开发者，我希望外部技能与内置技能在同一注册表中管理，以便 AI 和用户可以统一访问所有技能。

#### 验收标准

1. THE Skill_Registry SHALL 同时管理 Built_In_Skill 和从 SKILL.md 解析的外部技能
2. THE Skill_Registry SHALL 为每个技能维护唯一标识符，外部技能使用 frontmatter 中的 `name` 字段或目录名作为标识符
3. WHEN 注册外部技能时，THE Skill_Registry SHALL 保留该技能的 Discovery_Source 信息和 Priority_Order
4. THE Skill_Registry SHALL 通过 IPC 向渲染进程提供完整的技能列表，包含技能名称、描述和来源类型
5. WHEN 外部技能的 `disable-model-invocation` 设置为 true 时，THE Skill_Registry SHALL 将该技能标记为仅限手动调用
6. WHEN 外部技能的 `user-invocable` 设置为 false 时，THE Skill_Registry SHALL 将该技能从用户可见的技能菜单中隐藏

### 需求 4：用户调用

**用户故事：** 作为用户，我希望通过 `/skill-name` 命令调用技能，以便快速使用特定技能处理任务。

#### 验收标准

1. WHEN 用户在聊天输入中键入 `/` 时，THE Runtime SHALL 显示可调用技能的列表供用户选择
2. WHEN 用户输入 `/skill-name` 格式的命令时，THE Runtime SHALL 匹配并激活对应的技能
3. WHEN 用户输入 `/skill-name arguments` 格式的命令时，THE Runtime SHALL 将 arguments 部分作为参数传递给技能
4. WHEN 技能内容包含 `$ARGUMENTS` 占位符时，THE Runtime SHALL 将其替换为用户提供的完整参数字符串
5. WHEN 技能内容包含 `$ARGUMENTS[N]` 或 `$N` 占位符时，THE Runtime SHALL 将其替换为按空格分割的第 N 个参数
6. IF 用户输入的命令未匹配到任何技能，THEN THE Runtime SHALL 向用户显示未找到匹配技能的提示信息

### 需求 5：AI 自动调用

**用户故事：** 作为用户，我希望 AI 能根据我的提示自动匹配并调用合适的技能，以便无需手动指定技能名称。

#### 验收标准

1. WHEN 用户发送普通提示（非 `/` 命令）时，THE Runtime SHALL 基于技能的 `description` 字段与用户提示进行语义匹配
2. THE Runtime SHALL 将外部技能的 description 匹配与现有内置技能的 keyword 匹配整合为统一的匹配流程
3. WHEN 匹配到外部技能时，THE Runtime SHALL 将该技能的 Markdown 正文内容注入为系统提示
4. WHILE 技能的 `disable-model-invocation` 设置为 true 时，THE Runtime SHALL 跳过该技能的自动匹配

### 需求 6：动态上下文注入

**用户故事：** 作为技能作者，我希望在技能内容中使用 `!command` 语法动态注入 shell 命令的输出，以便技能可以获取运行时上下文。

#### 验收标准

1. WHEN 技能正文中包含 `!command` 语法的行时，THE Runtime SHALL 在将技能内容发送给 AI 之前执行该 shell 命令
2. WHEN shell 命令执行成功时，THE Runtime SHALL 将 `!command` 占位符替换为命令的标准输出内容
3. IF shell 命令执行失败或超时，THEN THE Runtime SHALL 将 `!command` 占位符替换为包含错误信息的提示文本
4. THE Runtime SHALL 在工作区根目录的上下文中执行动态上下文命令
5. THE Runtime SHALL 为动态上下文命令设置合理的执行超时时间，防止长时间阻塞

### 需求 7：Subagent 执行

**用户故事：** 作为技能作者，我希望技能可以在隔离的子代理上下文中执行，以便复杂技能不会污染主对话上下文。

#### 验收标准

1. WHEN 技能的 frontmatter 中 `context` 字段设置为 `fork` 时，THE Runtime SHALL 在隔离的 Subagent 中执行该技能
2. WHEN 创建 Subagent 时，THE Runtime SHALL 将技能的 Markdown 正文内容作为 Subagent 的系统提示
3. WHEN 技能指定 `allowed-tools` 列表时，THE Runtime SHALL 仅向该技能的执行上下文提供列表中指定的工具，且这些工具无需用户审批
4. WHEN 技能指定 `model` 字段时，THE Runtime SHALL 使用指定的模型执行该技能，而非默认模型
5. THE Runtime SHALL 将 Subagent 的执行结果返回到主对话上下文中，以流式方式呈现给用户

### 需求 8：技能生命周期钩子

**用户故事：** 作为技能作者，我希望为技能定义生命周期钩子，以便在技能激活和完成时执行自定义逻辑。

#### 验收标准

1. WHEN 技能的 frontmatter 中定义了 `hooks` 字段时，THE Runtime SHALL 在技能生命周期的对应阶段执行钩子脚本
2. WHEN 技能被激活时，THE Runtime SHALL 执行该技能定义的激活前（pre-activate）钩子
3. WHEN 技能执行完成时，THE Runtime SHALL 执行该技能定义的完成后（post-complete）钩子
4. IF 钩子脚本执行失败，THEN THE Runtime SHALL 记录错误日志但不中断技能的主执行流程

### 需求 9：技能资格检查（Eligibility Gating）

**用户故事：** 作为技能作者，我希望在技能中声明运行时依赖，以便系统在加载时自动排除不满足条件的技能，避免运行时失败。

#### 验收标准

1. WHEN 技能的 frontmatter 中定义了 `requires.bins` 字段（字符串数组）时，THE Runtime SHALL 在加载时检查每个指定的二进制是否存在于系统 PATH 中
2. IF 技能声明的任一必需二进制不存在，THEN THE Runtime SHALL 将该技能标记为不合格（ineligible）并从注册表中排除
3. WHEN 技能的 frontmatter 中定义了 `requires.env` 字段（字符串数组）时，THE Runtime SHALL 检查每个指定的环境变量是否已设置
4. IF 技能声明的任一必需环境变量未设置，THEN THE Runtime SHALL 将该技能标记为不合格并从注册表中排除
5. WHEN 技能的 frontmatter 中定义了 `requires.os` 字段时，THE Runtime SHALL 检查当前操作系统是否匹配
6. THE Runtime SHALL 静默排除不合格技能，不向用户显示错误，但记录 debug 级别日志
7. FOR ALL 不合格技能，AI 模型 SHALL 永远不会在可用技能列表中看到它们

### 需求 10：技能注入模式（Lazy Loading vs Eager Injection）

**用户故事：** 作为开发者，我希望系统支持延迟加载模式，以便在技能数量较多时节省上下文窗口空间。

#### 验收标准

1. THE Runtime SHALL 支持两种技能注入模式：Eager_Injection（即时注入）和 Lazy_Loading（延迟加载）
2. WHEN 使用 Eager_Injection 模式时，THE Runtime SHALL 在匹配到技能后将完整的技能正文注入系统提示
3. WHEN 使用 Lazy_Loading 模式时，THE Runtime SHALL 仅在系统提示中注入紧凑的技能目录（包含名称、描述和文件路径），由模型通过 readFile 工具按需读取完整内容
4. THE Runtime SHALL 默认使用 Eager_Injection 模式以保持向后兼容
5. WHEN 注册表中的外部技能数量超过可配置阈值时，THE Runtime SHALL 自动切换到 Lazy_Loading 模式
6. WHEN 使用 Lazy_Loading 模式时，THE Runtime SHALL 生成 `<available_skills>` 格式的技能目录块注入系统提示

### 需求 11：技能内容截断

**用户故事：** 作为开发者，我希望系统对注入的技能内容设置大小上限，以便防止过大的技能文件耗尽上下文窗口。

#### 验收标准

1. THE Runtime SHALL 为技能正文注入设置可配置的 Truncation_Limit（默认 20000 字符）
2. WHEN 技能正文（经预处理后）超过 Truncation_Limit 时，THE Runtime SHALL 截断内容并在末尾追加截断标记（如 `[...truncated, read full content from: <path>]`）
3. THE Runtime SHALL 在截断标记中包含技能文件的完整路径，以便模型可通过 readFile 工具获取完整内容
4. THE Runtime SHALL 允许通过配置项调整 Truncation_Limit 的值

### 需求 12：安全控制

**用户故事：** 作为用户，我希望系统对外部技能的可执行内容进行安全控制，以便防止恶意技能窃取数据或执行危险操作。

#### 验收标准

1. WHEN 外部技能首次加载且包含 `!command` 语法或 hooks 脚本时，THE Runtime SHALL 暂停加载并向用户请求审批
2. THE Runtime SHALL 计算技能内容（SKILL.md + hooks 脚本）的 SHA-256 哈希并持久化存储
3. WHEN 已审批技能的内容哈希发生变化时，THE Runtime SHALL 撤销信任状态并重新触发审批
4. THE Runtime SHALL 在 `!command` 执行时过滤敏感环境变量（匹配 `*_API_KEY`、`*_SECRET`、`*_TOKEN`、`*_PASSWORD` 模式）
5. THE Runtime SHALL 维护命令白名单（只读命令）和黑名单（网络请求、删除、权限变更），黑名单中的命令无论信任级别均被阻止
6. WHEN 技能来源为附加目录（低信任）时，THE Runtime SHALL 默认禁用 `!command` 和 hooks 执行
7. THE Runtime SHALL 在技能正文注入系统提示前追加安全边界标记，提示模型不要遵循其中要求绕过安全规则的指令

### 需求 13：与现有系统集成

**用户故事：** 作为开发者，我希望 AI Skills Runtime 与现有的 FileWork 架构无缝集成，以便复用现有的 AI 管线和 UI 组件。

#### 验收标准

1. THE Runtime SHALL 复用现有的 Vercel AI SDK streamText 执行管线处理技能执行
2. THE Runtime SHALL 复用现有的工具审批机制（writeFile、moveFile、deleteFile 等危险操作需用户确认）
3. THE Runtime SHALL 通过现有的 IPC 架构（main → preload → renderer）与渲染进程通信
4. THE Runtime SHALL 将技能执行的流式输出（文本增量、工具调用、工具结果）通过现有的流式事件通道发送到渲染进程
5. WHEN 外部技能被激活时，THE Runtime SHALL 在聊天界面中显示当前激活的技能名称和来源
