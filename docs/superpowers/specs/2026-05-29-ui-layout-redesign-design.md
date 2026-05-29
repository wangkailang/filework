# filework UI 布局重构设计

- 日期:2026-05-29
- 状态:设计已确认,待用户复核 → 转 writing-plans
- 范围:`src/renderer` 渲染层布局结构;不改后端 / IPC / 工具逻辑

## 1. 背景与目标

filework 定位是 **Workspace Agent**(本地 AI 智能体),但当前布局偏 IDE 形态。用户确认的 5 个痛点:

1. **聊天被压缩**:打开文件时 `FilePreviewPanel` 占 `w-7/10`、`ChatPanel` 被挤到 `w-3/10`,且为写死比例、不可拖。
2. **右侧面板互相抢位**:`FilePreviewPanel` / `BranchDiffPanel` / `BrowserPanel` 各自塞进同一 flex 行,无统一"停靠 + 标签"系统,多个同时打开会溢出。
3. **左栏只有文件树**:缺少会话/历史导航;会话历史目前藏在 `ChatPanel` 内的浮层 `SessionList`。
4. **顶栏被浪费**:标题栏仅 `-webkit-app-region: drag` 空拖拽条,未承载分支 / 模型 / workspace 等上下文。
5. **观感偏 IDE**:希望更接近现代 AI 助手(Claude Desktop / ChatGPT / Codex)的简洁观感与留白。

**目标**:重构为"混合三区"布局(方案 C),对话恒为主、文件保持一等公民,右侧上下文统一停靠,顶栏承载上下文。参考对象:Claude Desktop(会话为中心)、Codex/Cursor(工作台 + 可停靠面板)、Zed/Linear(分段切换 + 干净留白)。

**非目标(本次不做)**:
- 不换肤:`global.css` 的 `@theme` 颜色 token 保留;本次只动结构、间距、居中。
- 不重排 Settings 内部 8 个 tab(仅入口移到顶栏齿轮)。
- 不引入路由库,延续 `App.tsx` 状态驱动。
- WelcomeScreen、SkillsModal、GitHub/GitLab 等 onboarding modal 行为不变(入口位置可微调)。

## 2. 总体布局(方案 C · 混合三区)

```
┌─ TopBar(h~40,drag区;红绿灯 | filework · ⎇branch · ◇model ……… ⟲ ＋ ⚙)┐
├──────────────┬───────────────────────────────┬──────────────────────────┤
│ LeftRail     │ ConversationArea              │ ContextDock(可选)        │
│ [对话|文件]  │ 居中阅读列(max-w ~720)       │ 标签:预览 · Diff · Web  │
│ 会话历史 /   │ 消息流 + 工具卡               │ ←可拖分隔条              │
│ 文件树       │ ┌─────────────┐               │ 文件预览/差异/浏览器     │
│ 可拖宽/可折叠│ │ 输入框      │               │ 可拖宽 · 可关 · 窄窗转   │
│              │ └─────────────┘               │ 浮层抽屉                 │
└──────────────┴───────────────────────────────┴──────────────────────────┘
```

确认的关键决策:
- **对话列**:居中阅读列(max-width ~720–768px),两侧留白;代码块/工具卡可在列内自行加宽。
- **Dock 出现方式**:分栏可拖宽(像 Cursor/Zed);对话保留最小宽度(~420px);当 `窗口宽 < 左栏 + 最小对话 + Dock` 时,Dock 自动转为**右侧浮层抽屉**(带阴影/遮罩),关掉即完全回到对话。

## 3. 各区域详细设计

### 3.1 顶栏 `TopBar`(新增 `components/layout/TopBar.tsx`)
- 整条为 `titlebar-drag` 区域;内部交互控件加 `titlebar-no-drag`。
- 左侧留出 macOS 红绿灯空间(`pl` 适配)。
- 左中:`filework`(workspace 名,点击=切换/关闭 workspace 菜单)+ **BranchSwitcher**(从 `Sidebar` 迁来)+ **ModelSelector**(从 `ChatPanel` 输入页脚迁来,作为权威模型切换入口)。
- 右侧:历史开关(切左栏到"对话")· 新对话(`＋`)· 设置齿轮(开 `SettingsModal`)。
- 远程 workspace 显示 kind 徽标(Local/GitHub/GitLab),沿用现有逻辑。

### 3.2 左栏 `LeftRail`(重构现 `Sidebar.tsx`)
- 顶部 `[对话 | 文件]` 分段开关(`railTab: 'chats' | 'files'`)。
- **对话** → 抽取 `ChatHistoryPanel`:把现 `ChatPanel` 内的浮层 `SessionList` 提为常驻面板;按日期分组(今天/更早),活动项高亮(`inset 2px primary`),hover 显示删除;顶部"＋ 新对话"。
- **文件** → 抽取 `FileTreePanel`:沿用现有 `FileTree` 懒加载 + 根目录不可访问的错误横幅。
- 沿用现有可拖宽(180–480px,持久化)+ 可折叠(`SidebarExpandFloatingButton`);localStorage key 由 `filework-sidebar-*` 迁移/复用为 rail。
- 原 workspace 头部(名称/刷新/关闭)与分支 chip → 移至 TopBar。底部页脚保留 Skills 入口;Settings 移至 TopBar。

### 3.3 中间 `ConversationArea`(重构 `ChatPanel.tsx`)
- 移除面板内 toolbar(History + 新对话 → 左栏/顶栏)。
- 消息流渲染在**居中阅读列**(max-width 容器 + 自适应左右 padding);`Conversation`/`Message`/`Tool`/`PlanViewer` 等 ai-elements 内部结构不变。
- 底部输入框同样居中到列宽;页脚保留 `PromptInputAttachButton` + 一个**轻量模型 chip**(镜像顶栏 `ModelSelector`,点击打开同一选择器)+ `Brain`(WorkspaceMemory)+ 发送。
- 空态(建议提示)与拖拽上传 overlay 不变。

### 3.4 右侧 `ContextDock`(新增 `components/dock/ContextDock.tsx`)
- 统一容器,标签页托管现有面板作为内容:
  - **预览** ← `FilePreviewPanel`(filePath)
  - **Diff** ← `BranchDiffPanel`(显示 +/- 徽标)
  - **Web** ← `BrowserPanel`(url)
- 触发:点文件树文件 → 打开/激活"预览";顶栏/左栏的 diff 开关 → "Diff";agent/链接打开 → "Web"(沿用 `BrowserRouterProvider`)。
- 左边缘可拖分隔条(复用 Sidebar 的拖拽模式);对话最小宽度 ~420px 保底;窄窗自动转浮层抽屉(`absolute right-0` + 阴影 + 半透明遮罩)。
- 关闭(✕)→ 对话收回中部;Dock 宽度持久化 `filework-dock-width`。

## 4. 状态与数据流改动(`App.tsx`)

- **移除** `selectedFilePath` 驱动的 70/30 split;**引入** `dock` 状态:
  `{ open: boolean; activeTab: 'preview'|'diff'|'web'; filePath: string|null; url: string|null; width: number }`,
  把现有 `branchDiffOpen`、`browserUrl` 合并进来。
- **抽取会话状态到 `ChatSessionProvider` context**(workspace 视图层):把现在位于 `ChatPanel` 内的 `useChatSession`(内部用 `useSessionCrud`)上提为 Provider,`LeftRail` 的 `ChatHistoryPanel` 与 `ConversationArea` 共用同一份 `sessions / activeSessionId / messages / 新建/选择/删除/fork`。这是支撑"左栏常驻会话列表"的核心重构,也是最大风险点(见 §7)。
- 左栏状态:`railTab`、复用 `sidebarWidth/collapsed`(更名 `rail*`)。
- 顶栏消费 workspace + `BranchSwitcher` + `ModelSelector`。

## 5. 组件清单

| 组件 | 动作 | 说明 |
|---|---|---|
| `layout/TopBar.tsx` | 新增 | 上下文条;收纳 BranchSwitcher + ModelSelector + 历史/新对话/设置 |
| `layout/Sidebar.tsx` → `layout/LeftRail.tsx` | 重构 | 分段 [对话\|文件];宿主两个子面板 |
| `layout/ChatHistoryPanel.tsx` | 抽取 | 由浮层 `SessionList` 提为常驻 |
| `layout/FileTreePanel.tsx` | 抽取 | 现有文件树 + 错误横幅 |
| `dock/ContextDock.tsx` | 新增 | 标签页 + 分隔条 + 窄窗 overlay |
| `chat/ChatPanel.tsx` → `chat/ConversationArea.tsx` | 重构 | 去 toolbar;居中阅读列 |
| `chat/ChatSessionProvider.tsx` | 新增 | 上提 useChatSession/useSessionCrud |
| `chat/SessionList.tsx` | 复用/内联 | 列表项渲染并入 ChatHistoryPanel |
| `FilePreviewPanel`/`BranchDiffPanel`/`BrowserPanel` | 复用 | 改为 Dock 标签内容,去掉各自的外框/关闭按钮 |
| `App.tsx` | 重构 | 三区 flex 骨架 + dock/rail 状态 + Provider |

## 6. 实施阶段概要(交 writing-plans 细化)

- **P1 顶栏骨架**:新增 `TopBar`,迁 `BranchSwitcher`/`ModelSelector`;`App` 改三区 flex 外壳(暂不动 Dock 逻辑)。
- **P2 左栏 + 会话上提**:`ChatSessionProvider`;抽 `ChatHistoryPanel`/`FileTreePanel`;`LeftRail` 分段。
- **P3 对话区**:`ConversationArea` 居中阅读列;去内部 toolbar;输入页脚精简。
- **P4 ContextDock**:标签 + 分隔条 + 最小宽度 + 窄窗 overlay 兜底;收纳三面板。
- **P5 打磨**:间距/空态/键盘可达性/持久化/i18n(en·zh-CN·ja)/暗亮主题核对。

每阶段保持可运行、`pnpm typecheck` 与 `pnpm test` 绿。

## 7. 风险

- **会话状态上提**:`useSessionCrud` 有 `freshSessionIdRef`、debounced save、StrictMode 双发等微妙之处;上提为 Provider 时须保持这些不变量,避免 race-wipe 在途消息。建议先纯搬移、后接线,逐步验证。
- **Dock 分栏 / 最小宽度 / 窄窗断点**:把"窗口宽度 → split vs overlay"的判定抽成纯函数并加 vitest;ResizeObserver 或 window resize 监听。
- **顶栏拖拽区**:`-webkit-app-region: drag` 会吞掉按钮点击 —— 所有交互控件须 `titlebar-no-drag`。
- **localStorage 迁移**:`filework-sidebar-*` → rail 命名,避免老用户丢失宽度偏好(做一次性读旧写新)。

## 8. 测试 / 验证

- 纯逻辑(dock 宽度 clamp、窄窗断点、rail 宽度 clamp)→ vitest。
- 手动跑 app(`pnpm dev`):拖宽/折叠/持久化、文件→预览、diff→Diff 标签、链接→Web 标签、窄窗 overlay、暗/亮主题、空 workspace(Welcome)不受影响。
- 代码注释一律中文(项目规范)。
