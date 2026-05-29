# filework UI 布局重构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 filework 渲染层从"文件优先 IDE"布局重构为"混合三区"AI 助手布局(顶栏承载上下文 / 左栏分段切换会话·文件 / 中部居中对话 / 右侧统一 ContextDock)。

**Architecture:** 先把藏在 `ChatPanel` 里的会话状态上提为 `ChatSessionProvider`(纯搬移、零 UI 变化)以拆掉最大耦合;再分阶段引入 `TopBar`、`LeftRail`(分段)、居中对话列、`ContextDock`(标签 + 可拖分隔条 + 窄窗浮层)。布局几何(宽度 clamp / split↔overlay 断点)抽成纯函数模块并 TDD。延续 `App.tsx` 状态驱动,不引路由。

**Tech Stack:** React 19 + TypeScript + Tailwind CSS 4(`@theme` in `global.css`)+ lucide-react + typesafe-i18n + vitest + electron-vite。

---

## 约定(每个任务都遵守)

- **验证命令**:`pnpm typecheck`(tsc --noEmit)、`pnpm test`(vitest run 全量)、单测 `pnpm exec vitest run <file>`、`pnpm lint`(biome)。可视化改动用 `pnpm dev` 手动跑 app 观察(本计划标注为 **手动验收**)。
- **代码注释一律中文**(项目规范)。
- **提交前缀**:`feat(ui):` / `refactor(ui):` / `test(ui):`。提交信息末尾保留项目既有 Co-Authored-By 规范。
- **i18n**:任何新可见文案都加进 `src/renderer/i18n/en/index.ts`、`zh-CN/index.ts`、`ja/index.ts`(沿用既有键风格,如 `sidebar_settings`),再跑 `pnpm typesafe-i18n` 重新生成类型。
- **每个任务自成一次提交**,提交前 `pnpm typecheck` 必须绿。

## File Structure(本次新增/改动)

| 文件 | 责任 |
|---|---|
| `src/renderer/components/layout/layout-geometry.ts` | 纯函数:宽度 clamp、split↔overlay 断点。无 React。 |
| `src/renderer/components/layout/__tests__/layout-geometry.test.ts` | 上述纯函数单测。 |
| `src/renderer/components/chat/ChatSessionProvider.tsx` | 把 `useChatSession` 上提为 context;导出 Provider + `useChatSessionContext()`。 |
| `src/renderer/components/layout/TopBar.tsx` | 顶栏:workspace 标识 + BranchSwitcher + diff 开关 + ModelSelector + 历史/新对话/设置。 |
| `src/renderer/components/layout/LeftRail.tsx` | 左栏外壳:`[对话\|文件]` 分段 + 宽度/折叠 + 宿主两子面板。由 `Sidebar.tsx` 重构而来。 |
| `src/renderer/components/layout/ChatHistoryPanel.tsx` | 常驻会话列表(由 `SessionList` 浮层提升)。 |
| `src/renderer/components/layout/FileTreePanel.tsx` | 文件树 + 根目录错误横幅(由 `Sidebar` 抽出)。 |
| `src/renderer/components/dock/ContextDock.tsx` | 右侧统一停靠:`预览/Diff/Web` 标签 + 可拖分隔条 + 窄窗浮层。宿主三个既有面板。 |
| `src/renderer/components/chat/ConversationArea.tsx` | 由 `ChatPanel.tsx` 重构:去内部 toolbar/SessionList,居中阅读列。 |
| `src/renderer/App.tsx` | 三区 flex 骨架 + dock/rail 状态 + 挂 Provider。 |

> 说明:`Sidebar.tsx`→`LeftRail.tsx`、`ChatPanel.tsx`→`ConversationArea.tsx` 为"重命名式重构"——保留绝大多数内部逻辑,仅按下述精确改动调整。`SessionList.tsx` 的列表项渲染并入 `ChatHistoryPanel.tsx` 后删除原文件。`FilePreviewPanel`/`BranchDiffPanel`/`BrowserPanel` 不改内部,仅由 `ContextDock` 作为标签内容承载。

---

## Phase 0 — 布局几何纯函数(TDD)

### Task 0.1:layout-geometry 模块

**Files:**
- Create: `src/renderer/components/layout/layout-geometry.ts`
- Test: `src/renderer/components/layout/__tests__/layout-geometry.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// src/renderer/components/layout/__tests__/layout-geometry.test.ts
import { describe, expect, it } from "vitest";
import {
  DOCK_DEFAULT_WIDTH,
  DOCK_MAX_WIDTH,
  DOCK_MIN_WIDTH,
  MIN_CHAT_WIDTH,
  RAIL_MAX_WIDTH,
  RAIL_MIN_WIDTH,
  clampDockWidth,
  clampRailWidth,
  resolveDockMode,
} from "../layout-geometry";

describe("clampRailWidth", () => {
  it("夹在 [RAIL_MIN, RAIL_MAX] 区间", () => {
    expect(clampRailWidth(0)).toBe(RAIL_MIN_WIDTH);
    expect(clampRailWidth(9999)).toBe(RAIL_MAX_WIDTH);
    expect(clampRailWidth(300)).toBe(300);
  });
  it("NaN 回落到 RAIL_MIN", () => {
    expect(clampRailWidth(Number.NaN)).toBe(RAIL_MIN_WIDTH);
  });
});

describe("clampDockWidth", () => {
  it("夹在 [DOCK_MIN, DOCK_MAX] 区间", () => {
    expect(clampDockWidth(0)).toBe(DOCK_MIN_WIDTH);
    expect(clampDockWidth(99999)).toBe(DOCK_MAX_WIDTH);
    expect(clampDockWidth(DOCK_DEFAULT_WIDTH)).toBe(DOCK_DEFAULT_WIDTH);
  });
});

describe("resolveDockMode", () => {
  it("空间够 → split", () => {
    expect(
      resolveDockMode({
        windowWidth: 1440,
        railWidth: 256,
        railCollapsed: false,
        dockWidth: 420,
      }),
    ).toBe("split");
  });
  it("空间不足以容纳最小对话宽 → overlay", () => {
    // 1000 - 256 - 420 = 324 < MIN_CHAT_WIDTH(420)
    expect(
      resolveDockMode({
        windowWidth: 1000,
        railWidth: 256,
        railCollapsed: false,
        dockWidth: 420,
      }),
    ).toBe("overlay");
  });
  it("rail 折叠时把其宽度计为 0", () => {
    // 折叠:1000 - 0 - 420 = 580 >= 420 → split
    expect(
      resolveDockMode({
        windowWidth: 1000,
        railWidth: 256,
        railCollapsed: true,
        dockWidth: 420,
      }),
    ).toBe("split");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run src/renderer/components/layout/__tests__/layout-geometry.test.ts`
Expected: FAIL,报 `Cannot find module '../layout-geometry'`。

- [ ] **Step 3: 写最小实现**

```ts
// src/renderer/components/layout/layout-geometry.ts
// 布局几何:左栏/Dock 宽度 clamp,以及 Dock 在窗口里该用分栏还是浮层。
// 纯函数、无 React,便于单测与复用。

export const RAIL_MIN_WIDTH = 180;
export const RAIL_MAX_WIDTH = 480;
export const RAIL_DEFAULT_WIDTH = 256;

export const DOCK_MIN_WIDTH = 280;
export const DOCK_MAX_WIDTH = 720;
export const DOCK_DEFAULT_WIDTH = 420;

/** 对话区的最小可读宽度;低于它时 Dock 改用浮层,避免重演"聊天被压到 30%"。 */
export const MIN_CHAT_WIDTH = 420;

const clamp = (n: number, min: number, max: number, fallback: number): number =>
  Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;

export const clampRailWidth = (n: number): number =>
  clamp(n, RAIL_MIN_WIDTH, RAIL_MAX_WIDTH, RAIL_MIN_WIDTH);

export const clampDockWidth = (n: number): number =>
  clamp(n, DOCK_MIN_WIDTH, DOCK_MAX_WIDTH, DOCK_DEFAULT_WIDTH);

export type DockMode = "split" | "overlay";

/** 窗口放不下"左栏 + 最小对话宽 + Dock"时返回 "overlay",否则 "split"。 */
export const resolveDockMode = (args: {
  windowWidth: number;
  railWidth: number;
  railCollapsed: boolean;
  dockWidth: number;
}): DockMode => {
  const rail = args.railCollapsed ? 0 : args.railWidth;
  const remainingForChat = args.windowWidth - rail - args.dockWidth;
  return remainingForChat < MIN_CHAT_WIDTH ? "overlay" : "split";
};
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec vitest run src/renderer/components/layout/__tests__/layout-geometry.test.ts`
Expected: PASS(3 个 describe 全绿)。

- [ ] **Step 5: 提交**

```bash
git add src/renderer/components/layout/layout-geometry.ts src/renderer/components/layout/__tests__/layout-geometry.test.ts
git commit -m "feat(ui): 布局几何纯函数(宽度 clamp + split/overlay 断点)+ 单测"
```

---

## Phase 1 — 会话状态上提为 Provider(纯搬移,零 UI 变化)

> 目标:把 `ChatPanel` 内的 `const chat = useChatSession(...)` 提升到一个 Provider,使后续左栏会话列表与顶栏新对话能共享同一份状态。本阶段**不改任何视觉**——app 跑起来应与现在一模一样。这是最高风险点,单独成阶段以便回归。

### Task 1.1:创建 ChatSessionProvider

**Files:**
- Create: `src/renderer/components/chat/ChatSessionProvider.tsx`

- [ ] **Step 1: 写 Provider(完整代码)**

```tsx
// src/renderer/components/chat/ChatSessionProvider.tsx
// 把 useChatSession 的返回值放进 context,供对话区、左栏会话列表、顶栏共享。
// Provider 必须 key={workspacePath} 挂载,workspace 切换时整体重置。
import { createContext, useContext, useMemo } from "react";
import { useChatSession } from "./useChatSession";

type ChatSessionValue = ReturnType<typeof useChatSession>;
// 顶栏/左栏只需的低频字段(不含高频 messages),用于切片 Context。
type ChatSessionLiteValue = Pick<
  ChatSessionValue,
  | "sessions"
  | "activeSessionId"
  | "selectedLlmConfigId"
  | "isLoading"
  | "setSelectedLlmConfigId"
  | "handleNewChat"
  | "handleSelectSession"
  | "handleDeleteSession"
>;

const ChatSessionContext = createContext<ChatSessionValue | null>(null);
const ChatSessionLiteContext = createContext<ChatSessionLiteValue | null>(null);

export const ChatSessionProvider = ({
  workspacePath,
  workspaceRefJson,
  children,
}: {
  workspacePath: string;
  workspaceRefJson?: string;
  children: React.ReactNode;
}) => {
  const value = useChatSession(workspacePath, workspaceRefJson);
  // 低频切片:顶栏/左栏只用这些字段,且它们在流式逐 token 更新(messages
  // 变化)时不变。useMemo 让切片引用稳定 → Context 自动 bail-out,这两个区
  // 在流式期间不重渲染,等同 zustand selector 的效果。详见下方"性能注记"。
  const lite = useMemo<ChatSessionLiteValue>(
    () => ({
      sessions: value.sessions,
      activeSessionId: value.activeSessionId,
      selectedLlmConfigId: value.selectedLlmConfigId,
      isLoading: value.isLoading,
      setSelectedLlmConfigId: value.setSelectedLlmConfigId,
      handleNewChat: value.handleNewChat,
      handleSelectSession: value.handleSelectSession,
      handleDeleteSession: value.handleDeleteSession,
    }),
    [
      value.sessions,
      value.activeSessionId,
      value.selectedLlmConfigId,
      value.isLoading,
      value.setSelectedLlmConfigId,
      value.handleNewChat,
      value.handleSelectSession,
      value.handleDeleteSession,
    ],
  );
  return (
    <ChatSessionContext.Provider value={value}>
      <ChatSessionLiteContext.Provider value={lite}>
        {children}
      </ChatSessionLiteContext.Provider>
    </ChatSessionContext.Provider>
  );
};

// 全量(含高频 messages):仅对话区 ConversationArea 用。
export const useChatSessionContext = (): ChatSessionValue => {
  const ctx = useContext(ChatSessionContext);
  if (!ctx) {
    throw new Error("useChatSessionContext 必须在 <ChatSessionProvider> 内使用");
  }
  return ctx;
};

// 低频切片:顶栏 TopBar、左栏 ChatHistoryPanel 用,流式期间不随 messages 重渲。
export const useChatSessionLite = (): ChatSessionLiteValue => {
  const ctx = useContext(ChatSessionLiteContext);
  if (!ctx) {
    throw new Error("useChatSessionLite 必须在 <ChatSessionProvider> 内使用");
  }
  return ctx;
};
```

> **性能注记(替代 zustand 的关键)**:`useChatSession` 目前把 `handleNewChat`/`handleSelectSession`/`setSelectedLlmConfigId` 写成每次渲染新建的箭头函数;要让上面 `lite` 切片在流式期间真正 bail-out,需把这几个 handler 用 `useCallback` 固定引用(`handleDeleteSession` 已是 useCallback)。这是对 `useChatSession` 的**附加、低风险**改动,随本任务一起做。
>
> **消费约定**:顶栏 `TopBar` 与左栏 `ChatHistoryPanel` 一律用 `useChatSessionLite()`;只有对话区 `ConversationArea` 用 `useChatSessionContext()`(它需要高频 `messages`)。下文这两个组件代码块里出现的 `useChatSessionContext()` 按此改为 `useChatSessionLite()`。

- [ ] **Step 2: typecheck**

Run: `pnpm typecheck`
Expected: PASS(新文件不被引用,仅类型自洽)。

- [ ] **Step 3: 提交**

```bash
git add src/renderer/components/chat/ChatSessionProvider.tsx
git commit -m "feat(ui): 新增 ChatSessionProvider(上提 useChatSession)"
```

### Task 1.2:ChatPanel 改为消费 context;App 挂 Provider

**Files:**
- Modify: `src/renderer/components/chat/ChatPanel.tsx:378`
- Modify: `src/renderer/App.tsx:340-361`

- [ ] **Step 1: ChatPanel 用 context 取代本地 hook**

在 `ChatPanel.tsx`,把第 378 行:

```tsx
  const chat = useChatSession(workspacePath, workspaceRefJson);
```

改为:

```tsx
  const chat = useChatSessionContext();
```

并把顶部 import(第 91 行附近)`import { useChatSession } from "./useChatSession";` 改为
`import { useChatSessionContext } from "./ChatSessionProvider";`。
`ChatPanel` 的 props(`workspacePath` / `workspaceRefJson`)保留不动——它们仍被 `WorkspaceMemoryModal`、拖拽上传等使用。

- [ ] **Step 2: App 用 Provider 包裹工作区视图**

在 `App.tsx`,把 `<BrowserRouterProvider …>` 内、包住 `<ChatPanel … />` 的结构改为在 `BrowserRouterProvider` 外层(或内层均可,只要包住所有需要会话态的子树)套上 Provider。最小改动:在 `App.tsx` 顶部 import:

```tsx
import { ChatSessionProvider } from "./components/chat/ChatSessionProvider";
```

把当前(298 行起)工作区分支最外层 `<div className="flex h-screen w-screen overflow-hidden">` 的**直接子树**用 Provider 包住,并 `key` 上 workspace:

```tsx
<ChatSessionProvider
  key={workspace.localPath}
  workspacePath={workspace.localPath}
  workspaceRefJson={workspaceRefJson}
>
  {/* 原有 Sidebar / main / panels 全部移入此处 */}
</ChatSessionProvider>
```

同时把 `<ChatPanel workspacePath={...} workspaceRefJson={...} />` 保留(props 不变)。

- [ ] **Step 3: typecheck**

Run: `pnpm typecheck`
Expected: PASS。

- [ ] **Step 4: 手动验收(关键回归)**

Run: `pnpm dev`
确认:① 发消息正常、流式更新正常;② 切换会话/新建会话/删除会话正常;③ 刷新 app 后历史会话仍在;④ StrictMode 下无重复创建空会话。若 ③④ 异常 → 检查 Provider 是否被 `key={workspace.localPath}` 正确重挂(不要 key 到会变化的 ref 上)。

- [ ] **Step 5: 提交**

```bash
git add src/renderer/components/chat/ChatPanel.tsx src/renderer/App.tsx
git commit -m "refactor(ui): ChatPanel 消费 ChatSessionProvider,App 挂载 Provider(无 UI 变化)"
```

---

## Phase 2 — TopBar + 三区骨架;迁移 BranchSwitcher / ModelSelector / Settings

### Task 2.1:创建 TopBar

**Files:**
- Create: `src/renderer/components/layout/TopBar.tsx`

新增 i18n 键(沿用既有风格,en/zh-CN/ja 三份后跑 `pnpm typesafe-i18n`):
- `topbar_history`(en: "History" / zh-CN: "历史" / ja: "履歴")
- `topbar_newChat`(en: "New chat" / zh-CN: "新对话" / ja: "新規チャット")
- `topbar_settings`(en: "Settings" / zh-CN: "设置" / ja: "設定")

- [ ] **Step 1: 写 TopBar(完整代码)**

```tsx
// src/renderer/components/layout/TopBar.tsx
// 顶栏:整条为 macOS 拖拽区(.titlebar-drag),交互控件加 .titlebar-no-drag。
// 左侧留出红绿灯空间(pl-20);承载 workspace 标识 + 分支切换 + diff 开关 +
// 模型选择 + 历史/新对话/设置。
import { GitCompareArrows, History, PanelLeftOpen, Plus, Settings } from "lucide-react";
import { useI18nContext } from "../../i18n/i18n-react";
import type { WorkspaceRef } from "../../types/workspace-ref";
import { workspaceRefLabel } from "../../types/workspace-ref";
import { useChatSessionContext } from "../chat/ChatSessionProvider";
import { ModelSelector } from "../chat/ModelSelector";
import { BranchSwitcher } from "./BranchSwitcher";

export const TopBar = ({
  workspaceRef,
  workspacePath,
  currentBranch,
  branchForChip,
  diffOpen,
  diffBadge,
  onToggleDiff,
  onBranchSwitched,
  onOpenSettings,
  onShowChats,
  railCollapsed,
  onExpandRail,
}: {
  workspaceRef?: WorkspaceRef;
  workspacePath: string;
  currentBranch?: string | null;
  branchForChip: string | null;
  diffOpen: boolean;
  diffBadge: { added: number; removed: number } | null;
  onToggleDiff?: () => void;
  onBranchSwitched?: (b: string) => void;
  onOpenSettings: () => void;
  onShowChats: () => void;
  railCollapsed: boolean;
  onExpandRail: () => void;
}) => {
  const { LL } = useI18nContext();
  const chat = useChatSessionContext();
  const label = workspaceRef ? workspaceRefLabel(workspaceRef) : workspacePath;

  return (
    <header className="titlebar-drag relative z-50 flex h-12 shrink-0 items-center gap-2 border-b border-border bg-background pl-20 pr-3">
      {railCollapsed && (
        <button
          type="button"
          onClick={onExpandRail}
          className="titlebar-no-drag rounded p-1.5 hover:bg-accent"
          title="展开侧栏"
        >
          <PanelLeftOpen className="size-4 text-muted-foreground" />
        </button>
      )}
      <span className="text-sm font-semibold text-foreground truncate max-w-[40%]">
        {label}
      </span>

      {branchForChip && (
        <div className="titlebar-no-drag flex items-center gap-1.5">
          <BranchSwitcher
            workspaceRef={workspaceRef}
            currentBranch={branchForChip}
            onSwitched={(b) => onBranchSwitched?.(b)}
          />
          {onToggleDiff && (
            <button
              type="button"
              onClick={onToggleDiff}
              title={LL.branch_diff_open()}
              className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] hover:bg-accent hover:text-foreground ${
                diffOpen
                  ? "border-primary/50 bg-accent/50 text-foreground"
                  : "border-border/60 text-muted-foreground"
              }`}
            >
              <GitCompareArrows className="size-3" />
              {diffBadge && (
                <span className="font-mono">
                  <span className="text-emerald-500">+{diffBadge.added}</span>{" "}
                  <span className="text-red-400">-{diffBadge.removed}</span>
                </span>
              )}
            </button>
          )}
        </div>
      )}

      <div className="flex-1" />

      <div className="titlebar-no-drag flex items-center gap-1">
        <ModelSelector
          selectedConfigId={chat.selectedLlmConfigId}
          onSelect={chat.setSelectedLlmConfigId}
        />
        <button
          type="button"
          onClick={onShowChats}
          className="rounded p-1.5 hover:bg-accent"
          title={LL.topbar_history()}
        >
          <History className="size-4 text-muted-foreground" />
        </button>
        <button
          type="button"
          onClick={chat.handleNewChat}
          disabled={chat.isLoading}
          className="rounded p-1.5 hover:bg-accent disabled:opacity-50"
          title={LL.topbar_newChat()}
        >
          <Plus className="size-4 text-muted-foreground" />
        </button>
        <button
          type="button"
          onClick={onOpenSettings}
          className="rounded p-1.5 hover:bg-accent"
          title={LL.topbar_settings()}
        >
          <Settings className="size-4 text-muted-foreground" />
        </button>
      </div>
    </header>
  );
};
```

- [ ] **Step 2: 加 i18n 键并重新生成**

按本任务开头列出的键加入三份 `index.ts`,然后 Run: `pnpm typesafe-i18n`,再 `pnpm typecheck`。
Expected: 类型生成无误,`LL.topbar_*` 可用。

- [ ] **Step 3: 提交**

```bash
git add src/renderer/components/layout/TopBar.tsx src/renderer/i18n
git commit -m "feat(ui): 新增 TopBar(workspace/分支/模型/历史/新对话/设置)"
```

### Task 2.2:App 引入三区骨架 + 渲染 TopBar;Sidebar 去掉已迁移控件

**Files:**
- Modify: `src/renderer/App.tsx`(替换 `isRestoring` 占位的 titlebar 与工作区分支 JSX)
- Modify: `src/renderer/components/layout/Sidebar.tsx`(删除 workspace 头部、分支 chip、Settings 按钮;`pt-12` 改为 `pt-0`)

- [ ] **Step 1: App 渲染 TopBar 并下沉内容**

把 `App.tsx` 工作区分支(298 行起)结构调整为:最外层纵向 flex,先 `TopBar`,再横向 row。删除原 `<div className="titlebar-drag fixed top-0 left-0 right-0 h-12 z-50" />`(顶栏已是真实拖拽区)。`main` 去掉 `pt-12`(顶栏已占位)。

新结构骨架(保留既有 Sidebar/ChatPanel/panels,props 不变,新增 TopBar 与下面 Phase 用到的状态):

```tsx
<div className="flex h-screen w-screen flex-col overflow-hidden">
  <TopBar
    workspaceRef={workspace.ref}
    workspacePath={workspace.localPath}
    currentBranch={workspace.currentBranch}
    branchForChip={branchForChip}
    diffOpen={branchDiffOpen}
    diffBadge={null}
    onToggleDiff={() => setBranchDiffOpen((v) => !v)}
    onBranchSwitched={handleBranchSwitched}
    onOpenSettings={() => window.dispatchEvent(new Event("filework:open-settings"))}
    onShowChats={() => { setRailTab("chats"); setSidebarCollapsed(false); }}
    railCollapsed={sidebarCollapsed}
    onExpandRail={() => setSidebarCollapsed(false)}
  />
  <ChatSessionProvider key={workspace.localPath} workspacePath={workspace.localPath} workspaceRefJson={workspaceRefJson}>
    <BrowserRouterProvider openInPanel={setBrowserUrl}>
      <div className="flex flex-1 overflow-hidden">
        <Sidebar … />{/* 暂仍是旧 Sidebar,Phase 3 换 LeftRail */}
        <main className="flex flex-1 overflow-hidden">
          {/* 文件预览 / Chat / branch-diff / browser —— Phase 4 收进 Dock,本阶段保留原样但去掉 pt-12 */}
        </main>
      </div>
    </BrowserRouterProvider>
  </ChatSessionProvider>
</div>
```

辅助:在 App 顶部新增 `const [railTab, setRailTab] = useState<"chats" | "files">("chats");`(Phase 3 用)。把内联的 `onBranchSwitched` 逻辑抽成 `handleBranchSwitched(branch)` 函数(沿用原 Sidebar 里传入的那段:local 改 currentBranch,remote 改 ref 并 recordRecent)。计算 `branchForChip`:`workspace.ref.kind === "local" ? (workspace.currentBranch ?? null) : workspace.ref.ref`。

> 注:`diffBadge` 暂传 `null`(顶栏不再自己拉 diff 摘要,避免重复请求);+/- 徽标 Phase 4 由 Dock 的 Diff 标签呈现。若需保留顶栏徽标,Phase 6 再接 `useBranchDiff`。

- [ ] **Step 2: Sidebar 删除已迁移控件**

在 `Sidebar.tsx`:
1. `<aside … className="… pt-12 …">` 改为 `pt-0`(顶栏已占位)。
2. 删除整段"Workspace header"块(322–421 行:名称按钮 + refresh/close/collapse + 分支 chip)。collapse 折叠按钮移到别处:在文件树上方保留一个小的折叠按钮即可(`PanelLeftClose`),或先依赖 TopBar 的展开按钮 + 后续 LeftRail 顶部分段栏处放折叠。最小改动:在底部 actions 行追加一个折叠按钮调用 `onToggleCollapsed`。
3. 底部 actions 删除 Settings 按钮(已移 TopBar);保留 Skills 按钮。
4. 顶部 import 清理 `BranchSwitcher`、`Settings`、`SettingsModal`、`useBranchDiff`、`GitCompareArrows`、`Github`/`Gitlab`/`FolderOpen`/`RefreshCw`/`X` 等不再用到的(以 `pnpm typecheck` 报错为准逐个删)。`refresh` 逻辑文件树仍需 → 保留 `handleRefresh`,在文件树区上方放一个 refresh 小按钮。
5. App 渲染 `<SettingsModal>`:Settings 入口移走后,把 `SettingsModal` 挂到 App 顶层(监听既有 `filework:open-settings` 事件;Sidebar 原本就有此监听,可整体搬到 App)。

> 为降低风险:Settings/Skills 的 Modal 挂载点可暂留 Sidebar 内(仅删按钮,保留事件监听 + `<SettingsModal>`),`onOpenSettings` 通过 `window.dispatchEvent(new Event("filework:open-settings"))` 触发现有监听。这样本步只删两个头部块 + Settings 按钮,Modal 不动。

- [ ] **Step 3: typecheck + lint**

Run: `pnpm typecheck && pnpm lint`
Expected: PASS(清理完未用 import 后)。

- [ ] **Step 4: 手动验收**

Run: `pnpm dev`
确认:顶栏出现且红绿灯不被遮挡、可拖动窗口;分支切换/ diff 开关/模型选择/新对话/设置齿轮均可用;左侧栏不再有重复的名称/分支/设置;`pt` 调整后无 12px 缝隙或重叠。

- [ ] **Step 5: 提交**

```bash
git add src/renderer/App.tsx src/renderer/components/layout/Sidebar.tsx
git commit -m "refactor(ui): App 三区骨架 + 渲染 TopBar;Sidebar 去掉已迁移的头部/分支/设置"
```

### Task 2.3:ChatPanel 输入页脚移除 ModelSelector(已在 TopBar)

**Files:**
- Modify: `src/renderer/components/chat/ChatPanel.tsx:1253-1278`

- [ ] **Step 1: 删除页脚里的 `<ModelSelector …>`**

在 `PromptInputFooter`(1253 行起)内删除 `<ModelSelector selectedConfigId={…} onSelect={…} />` 块;保留 `PromptInputAttachButton`、`Brain`(Memory)、`PromptInputSubmit`。清理顶部不再使用的 `import { ModelSelector }`。

- [ ] **Step 2: typecheck + 手动验收**

Run: `pnpm typecheck` 然后 `pnpm dev`:确认输入框仍可发送、附件与 Memory 按钮在,模型切换改由顶栏完成。

- [ ] **Step 3: 提交**

```bash
git add src/renderer/components/chat/ChatPanel.tsx
git commit -m "refactor(ui): 输入页脚去掉 ModelSelector(统一由 TopBar 切换模型)"
```

---

## Phase 3 — LeftRail 分段 + 抽取 ChatHistoryPanel / FileTreePanel

### Task 3.1:抽取 ChatHistoryPanel(常驻会话列表)

**Files:**
- Create: `src/renderer/components/layout/ChatHistoryPanel.tsx`

新增 i18n 键:`rail_chats`(对话/Chats/チャット)、`rail_files`(文件/Files/ファイル);复用既有 `session_*` 键。

- [ ] **Step 1: 写 ChatHistoryPanel(完整代码)**

```tsx
// src/renderer/components/layout/ChatHistoryPanel.tsx
// 常驻会话列表(由原 SessionList 浮层提升)。从 ChatSessionProvider 取数据。
import { MessageSquarePlus, Trash2 } from "lucide-react";
import { useI18nContext } from "../../i18n/i18n-react";
import { useChatSessionContext } from "../chat/ChatSessionProvider";

export const ChatHistoryPanel = () => {
  const { LL } = useI18nContext();
  const chat = useChatSessionContext();

  return (
    <div className="flex h-full flex-col">
      <button
        type="button"
        onClick={chat.handleNewChat}
        disabled={chat.isLoading}
        className="mx-2 mt-2 flex items-center justify-center gap-1.5 rounded-md border border-dashed border-border px-3 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
      >
        <MessageSquarePlus className="size-4" />
        {LL.session_newChat()}
      </button>
      <div className="mt-2 flex-1 overflow-y-auto">
        {chat.sessions.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">
            {LL.session_empty()}
          </div>
        ) : (
          chat.sessions.map((s) => (
            <div
              key={s.id}
              className={`group flex cursor-pointer items-center gap-2 px-3 py-2.5 transition-colors hover:bg-accent ${
                s.id === chat.activeSessionId
                  ? "bg-accent shadow-[inset_2px_0_0_var(--color-primary)]"
                  : ""
              }`}
            >
              <button
                type="button"
                className="min-w-0 flex-1 text-left"
                onClick={() => chat.handleSelectSession(s.id)}
              >
                <div className="truncate text-sm text-foreground">{s.title}</div>
                <div className="text-xs text-muted-foreground">
                  {new Date(s.updatedAt).toLocaleDateString()}
                </div>
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  chat.handleDeleteSession(s.id);
                }}
                className="p-1 text-muted-foreground opacity-0 transition-all hover:text-destructive group-hover:opacity-100"
                aria-label={LL.session_delete()}
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
};
```

- [ ] **Step 2: typecheck**(加 i18n 键 → `pnpm typesafe-i18n` → `pnpm typecheck`)。

- [ ] **Step 3: 提交**

```bash
git add src/renderer/components/layout/ChatHistoryPanel.tsx src/renderer/i18n
git commit -m "feat(ui): 抽取 ChatHistoryPanel(常驻会话列表)"
```

### Task 3.2:抽取 FileTreePanel

**Files:**
- Create: `src/renderer/components/layout/FileTreePanel.tsx`
- Modify: `src/renderer/components/layout/Sidebar.tsx`(把文件树相关 state/handlers + 错误横幅 + `renderEntries` 整段迁入新文件)

- [ ] **Step 1: 写 FileTreePanel**

把 `Sidebar.tsx` 中以下内容原样迁入 `FileTreePanel.tsx`:`FileInfo` 类型、`FS_ERROR_TAG_*`、`classifyListError`、`ListError`、文件树相关的 `files/childrenMap/expandedPaths/selectedPath/rootError` state、`handleSelect/loadFiles effect/handleExpandedChange/handleRefresh/handleGrantAccess`、`renderEntries`,以及"Error banner"+"File tree"两段 JSX。组件签名:

```tsx
// src/renderer/components/layout/FileTreePanel.tsx
export const FileTreePanel = ({
  workspacePath,
  onSelectFile,
}: {
  workspacePath: string;
  onSelectFile: (path: string) => void;
}) => { /* 迁入的逻辑 + 顶部一个 refresh 小按钮 + 错误横幅 + <FileTree> */ };
```

(完整代码 = 上述从 Sidebar 迁出的片段拼装;`onSelectFile` 即原 `onSelectFile` prop。)

- [ ] **Step 2: typecheck**:`pnpm typecheck`(此时 FileTreePanel 独立自洽,Sidebar 仍在用旧逻辑——下一任务整体替换)。

- [ ] **Step 3: 提交**

```bash
git add src/renderer/components/layout/FileTreePanel.tsx
git commit -m "feat(ui): 抽取 FileTreePanel(文件树 + 错误横幅)"
```

### Task 3.3:LeftRail 替换 Sidebar(分段 + 复用拖宽/折叠)

**Files:**
- Create: `src/renderer/components/layout/LeftRail.tsx`
- Modify: `src/renderer/App.tsx`(`<Sidebar … />` → `<LeftRail … />`,传 `railTab` / `onRailTabChange`)
- Delete: `src/renderer/components/layout/Sidebar.tsx`、`src/renderer/components/chat/SessionList.tsx`(逻辑已迁出)

- [ ] **Step 1: 写 LeftRail**

`LeftRail` = 原 `Sidebar` 的"外壳 + 拖宽/折叠/`SidebarExpandFloatingButton`"逻辑(startResize/handleResizeKey/resize handle/`if (collapsed) return null`),内容区改为顶部 `[对话|文件]` 分段开关 + 按 `railTab` 渲染 `<ChatHistoryPanel />` 或 `<FileTreePanel workspacePath onSelectFile />`,底部保留 Skills 按钮 + 折叠按钮。继续导出 `SidebarExpandFloatingButton`(或更名 `RailExpandFloatingButton`,App 同步)。

分段开关 JSX:

```tsx
<div className="titlebar-no-drag flex gap-0 m-2 rounded-lg border border-border overflow-hidden">
  <button type="button" onClick={() => onRailTabChange("chats")}
    className={`flex-1 py-1.5 text-xs ${railTab === "chats" ? "bg-primary text-primary-foreground font-semibold" : "text-muted-foreground"}`}>
    {LL.rail_chats()}
  </button>
  <button type="button" onClick={() => onRailTabChange("files")}
    className={`flex-1 py-1.5 text-xs ${railTab === "files" ? "bg-primary text-primary-foreground font-semibold" : "text-muted-foreground"}`}>
    {LL.rail_files()}
  </button>
</div>
```

Props:`{ workspacePath, railTab, onRailTabChange, onSelectFile, width, collapsed, onWidthChange, onCommitWidth, onToggleCollapsed }`。宽度 clamp 改用 `clampRailWidth`(import 自 `layout-geometry`),min/max 用 `RAIL_MIN_WIDTH`/`RAIL_MAX_WIDTH`。

- [ ] **Step 2: App 切换到 LeftRail**

`App.tsx` 把 `<Sidebar … />` 换成 `<LeftRail workspacePath={workspace.localPath} railTab={railTab} onRailTabChange={setRailTab} onSelectFile={openFileInDock} width={sidebarWidth} collapsed={sidebarCollapsed} onWidthChange={setSidebarWidth} onCommitWidth={handleCommitSidebarWidth} onToggleCollapsed={handleToggleSidebarCollapsed} />`。(`openFileInDock` 在 Phase 4 定义;本阶段先临时等于原 `setSelectedFilePath`。)删除 `Sidebar.tsx` 与 `SessionList.tsx`,清理 import。

- [ ] **Step 3: 删除 ChatPanel 内的 SessionList 浮层 + 顶部 toolbar**

在 `ChatPanel.tsx` 删除 1003–1011 行 `{showHistory && <SessionList … />}` 与 1013–1036 行的 toolbar `<div>`(History + 新对话);删除 `showHistory` state(376 行)与 `SessionList`/`History`/`MessageSquarePlus` import。会话历史与新对话现由左栏 + 顶栏负责。

- [ ] **Step 4: typecheck + lint + 手动验收**

Run: `pnpm typecheck && pnpm lint` 然后 `pnpm dev`。
确认:左栏 `[对话|文件]` 切换正常;"对话"显示会话列表、点选切换会话、删除、新对话;"文件"显示文件树、点文件触发预览;顶栏 History 图标把左栏切到"对话"并展开;拖宽/折叠/持久化仍工作;Skills 按钮在。

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "refactor(ui): Sidebar→LeftRail(分段对话/文件);删除 SessionList 浮层与 ChatPanel 内 toolbar"
```

---

## Phase 4 — ContextDock(统一停靠:预览/Diff/Web)

### Task 4.1:创建 ContextDock

**Files:**
- Create: `src/renderer/components/dock/ContextDock.tsx`

新增 i18n 键:`dock_preview`(预览/Preview/プレビュー)、`dock_diff`(差异/Diff/差分)、`dock_web`(网页/Web/Web)。

- [ ] **Step 1: 写 ContextDock(完整代码)**

```tsx
// src/renderer/components/dock/ContextDock.tsx
// 右侧统一停靠面板:预览/Diff/Web 三标签共用一个容器,可拖分隔条调宽。
// 由父级(App)通过 mode 决定分栏(参与 flex 布局)还是浮层(absolute 覆盖)。
import { X } from "lucide-react";
import { useCallback, useRef } from "react";
import { useI18nContext } from "../../i18n/i18n-react";
import { BranchDiffPanel } from "../branch-diff/BranchDiffPanel";
import { BrowserPanel } from "../browser/BrowserPanel";
import { FilePreviewPanel } from "../file-preview/FilePreviewPanel";
import {
  DOCK_MAX_WIDTH,
  DOCK_MIN_WIDTH,
  type DockMode,
} from "../layout/layout-geometry";

export type DockTab = "preview" | "diff" | "web";

export const ContextDock = ({
  mode,
  width,
  activeTab,
  onTabChange,
  onClose,
  onWidthChange,
  onCommitWidth,
  filePath,
  url,
  workspaceRoot,
  currentBranch,
  diffInvalidator,
}: {
  mode: DockMode;
  width: number;
  activeTab: DockTab;
  onTabChange: (t: DockTab) => void;
  onClose: () => void;
  onWidthChange: (w: number) => void;
  onCommitWidth: (w: number) => void;
  filePath: string | null;
  url: string | null;
  workspaceRoot: string;
  currentBranch?: string | null;
  diffInvalidator: number;
}) => {
  const { LL } = useI18nContext();
  const widthRef = useRef(width);
  widthRef.current = width;

  // 左边缘拖拽:向左拖变宽(dock 在右侧,所以 delta 取负)。
  const startResize = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = widthRef.current;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      const onMove = (ev: MouseEvent) => {
        const next = Math.min(
          DOCK_MAX_WIDTH,
          Math.max(DOCK_MIN_WIDTH, startWidth - (ev.clientX - startX)),
        );
        onWidthChange(next);
      };
      const onUp = () => {
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        onCommitWidth(widthRef.current);
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [onWidthChange, onCommitWidth],
  );

  const tabBtn = (t: DockTab, label: string) => (
    <button
      type="button"
      onClick={() => onTabChange(t)}
      className={`rounded-t-md px-3 py-1.5 text-xs ${
        activeTab === t
          ? "bg-card text-foreground shadow-[inset_0_-2px_0_var(--color-primary)]"
          : "text-muted-foreground hover:text-foreground"
      }`}
    >
      {label}
    </button>
  );

  return (
    <aside
      className={
        mode === "overlay"
          ? "absolute right-0 top-0 z-40 h-full border-l border-border bg-background shadow-2xl"
          : "relative h-full shrink-0 border-l border-border bg-background"
      }
      style={{ width }}
    >
      {/* 左边缘拖拽手柄 */}
      {/* biome-ignore lint/a11y/useSemanticElements: 竖向 resize 手柄用 div + ARIA 是分栏标准做法 */}
      <div
        onMouseDown={startResize}
        role="separator"
        aria-orientation="vertical"
        tabIndex={0}
        className="absolute left-0 top-0 z-10 h-full w-1 cursor-col-resize transition-colors hover:bg-primary/30"
      />
      <div className="flex h-9 items-center gap-1 border-b border-border px-2">
        {tabBtn("preview", LL.dock_preview())}
        {tabBtn("diff", LL.dock_diff())}
        {tabBtn("web", LL.dock_web())}
        <div className="flex-1" />
        <button type="button" onClick={onClose} className="rounded p-1 hover:bg-accent" aria-label="Close">
          <X className="size-3.5 text-muted-foreground" />
        </button>
      </div>
      <div className="h-[calc(100%-2.25rem)] overflow-hidden">
        {activeTab === "preview" &&
          (filePath ? (
            <FilePreviewPanel filePath={filePath} onClose={onClose} />
          ) : (
            <div className="p-4 text-sm text-muted-foreground">未选择文件</div>
          ))}
        {activeTab === "diff" && (
          <BranchDiffPanel
            workspaceRoot={workspaceRoot}
            currentBranch={currentBranch}
            invalidator={diffInvalidator}
            onClose={onClose}
          />
        )}
        {activeTab === "web" &&
          (url ? (
            <BrowserPanel url={url} onClose={onClose} />
          ) : (
            <div className="p-4 text-sm text-muted-foreground">无网页</div>
          ))}
      </div>
    </aside>
  );
};
```

> 注:`FilePreviewPanel`/`BranchDiffPanel`/`BrowserPanel` 内部自带外框/关闭/(浏览器还自带自己的拖宽);承载进 Dock 后,Phase 6 再精简它们各自的外框与重复拖宽(本阶段先功能跑通,允许轻微重复边框)。

- [ ] **Step 2: typecheck**(加 i18n → `pnpm typesafe-i18n` → `pnpm typecheck`)。

- [ ] **Step 3: 提交**

```bash
git add src/renderer/components/dock/ContextDock.tsx src/renderer/i18n
git commit -m "feat(ui): 新增 ContextDock(预览/Diff/Web 标签 + 可拖分隔条)"
```

### Task 4.2:App 用 Dock 状态取代 selectedFilePath / branchDiffOpen / browserUrl

**Files:**
- Modify: `src/renderer/App.tsx`

- [ ] **Step 1: 引入 dock 状态**

新增:
```tsx
import { ContextDock, type DockTab } from "./components/dock/ContextDock";
import { clampDockWidth, DOCK_DEFAULT_WIDTH, resolveDockMode } from "./components/layout/layout-geometry";
```
状态:
```tsx
const [dockOpen, setDockOpen] = useState(false);
const [dockTab, setDockTab] = useState<DockTab>("preview");
const [dockFilePath, setDockFilePath] = useState<string | null>(null);
const [dockWidth, setDockWidth] = useState<number>(() =>
  clampDockWidth(Number.parseInt(localStorage.getItem("filework-dock-width") || "", 10) || DOCK_DEFAULT_WIDTH),
);
const [winWidth, setWinWidth] = useState<number>(() => window.innerWidth);
useEffect(() => {
  const onResize = () => setWinWidth(window.innerWidth);
  window.addEventListener("resize", onResize);
  return () => window.removeEventListener("resize", onResize);
}, []);
```
打开 helpers:
```tsx
const openFileInDock = useCallback((path: string) => {
  setDockFilePath(path); setDockTab("preview"); setDockOpen(true);
}, []);
const commitDockWidth = useCallback((w: number) => {
  localStorage.setItem("filework-dock-width", String(w));
}, []);
```
把 `branchDiffOpen` 的切换改为:开 diff → `setDockTab("diff"); setDockOpen(true);`(`onToggleDiff` 实现为:若已在 diff 标签且开着则关,否则切到 diff 并开)。`browserUrl` 改为:`BrowserRouterProvider openInPanel={(u) => { setBrowserUrl(u); setDockTab("web"); setDockOpen(true); }}`(保留 `browserUrl` 作为 url 源)。

- [ ] **Step 2: 渲染 Dock,替换 70/30 split**

把 `main` 内的 `selectedFilePath ? w-7/10 … : flex-1` 三元结构删除,改为:对话区恒 `flex-1`,Dock 作为兄弟:
```tsx
<main className="relative flex flex-1 overflow-hidden">
  <div className="min-w-0 flex-1 overflow-hidden">
    <ChatPanel workspacePath={workspace.localPath} workspaceRefJson={workspaceRefJson} />
  </div>
  {dockOpen && (
    <ContextDock
      mode={dockMode}
      width={dockWidth}
      activeTab={dockTab}
      onTabChange={setDockTab}
      onClose={() => setDockOpen(false)}
      onWidthChange={setDockWidth}
      onCommitWidth={commitDockWidth}
      filePath={dockFilePath}
      url={browserUrl}
      workspaceRoot={workspace.localPath}
      currentBranch={workspace.currentBranch}
      diffInvalidator={diffInvalidator}
    />
  )}
</main>
```
其中:
```tsx
const dockMode = resolveDockMode({
  windowWidth: winWidth,
  railWidth: sidebarWidth,
  railCollapsed: sidebarCollapsed,
  dockWidth,
});
```
删除独立的 `<FilePreviewPanel>`、`<BranchDiffPanel>`、`<BrowserPanel>` 三处旧渲染(其能力已并入 Dock)。`LeftRail` 的 `onSelectFile` 改传 `openFileInDock`。`overlay` 模式下 Dock 用 `absolute` 覆盖,`main` 需 `relative`(已加)。

- [ ] **Step 3: typecheck + lint**:`pnpm typecheck && pnpm lint`。

- [ ] **Step 4: 手动验收(核心)**

Run: `pnpm dev`,逐项确认:
1. 点文件树文件 → Dock"预览"标签打开,**对话区不再被压到 30%**,可拖分隔条调宽。
2. 顶栏 diff 开关 → Dock"Diff"标签;link 打开 → "Web"标签;三者标签互切、关 Dock 后对话占满。
3. 把窗口拖窄到放不下"左栏+最小对话+Dock" → Dock 自动变为右侧浮层(覆盖、带阴影);拖宽回去 → 变回分栏。
4. 重开 app,Dock 宽度被记住。

- [ ] **Step 5: 提交**

```bash
git add src/renderer/App.tsx
git commit -m "refactor(ui): 用 ContextDock 取代 70/30 split 与三个独立右侧面板"
```

---

## Phase 5 — 居中对话阅读列

### Task 5.1:ConversationArea 居中列

**Files:**
- Modify: `src/renderer/components/chat/ChatPanel.tsx`(可同时 `git mv` 为 `ConversationArea.tsx` 并改 import;为降风险也可保留文件名,仅改内部)

- [ ] **Step 1: 给消息流与输入框套居中列容器**

在 `Conversation`(1044 行起)的内容与 `PromptInput`(1230 行起)外层各包一个居中容器:`<div className="mx-auto w-full max-w-3xl px-4">…</div>`(`max-w-3xl` ≈ 768px;可按需 `max-w-[720px]`)。即:`ConversationContent` 内列表与底部 `PromptInput` 都约束到同一最大宽度并水平居中,`section` 仍 `flex flex-col h-full`。代码块/工具卡在列内自然撑满列宽。

- [ ] **Step 2:(可选)重命名文件**

```bash
git mv src/renderer/components/chat/ChatPanel.tsx src/renderer/components/chat/ConversationArea.tsx
```
若执行重命名:把组件导出名 `ChatPanel`→`ConversationArea`,更新 `App.tsx` import 与用法。不重命名亦可,后续以现名继续。

- [ ] **Step 3: typecheck + 手动验收**

Run: `pnpm typecheck` → `pnpm dev`:确认长对话居中、两侧留白;窄窗(含 Dock overlay)下仍可读、输入框不溢出;空态(建议提示)居中正常。

- [ ] **Step 4: 提交**

```bash
git add -A
git commit -m "feat(ui): 对话区改为居中阅读列(max-w-3xl)"
```

---

## Phase 6 — 打磨与收尾

### Task 6.1:localStorage 键迁移(sidebar→rail,一次性)

**Files:**
- Modify: `src/renderer/App.tsx`(初始化读取处)

- [ ] **Step 1: 兼容旧键**

`getInitialSidebarWidth` / `getInitialSidebarCollapsed` 读取时,优先读新键 `filework-rail-width`/`filework-rail-collapsed`,回落到旧键 `filework-sidebar-*`;提交宽度/折叠时写新键。用 `clampRailWidth` 夹取。保证老用户偏好不丢。

- [ ] **Step 2: typecheck + 手动验收 + 提交**

```bash
git add src/renderer/App.tsx
git commit -m "refactor(ui): rail 宽度/折叠 localStorage 键迁移(兼容旧 sidebar-*)"
```

### Task 6.2:精简被 Dock 承载的面板的重复外框

**Files:**
- Modify: `src/renderer/components/file-preview/FilePreviewPanel.tsx`、`branch-diff/BranchDiffPanel.tsx`、`browser/BrowserPanel.tsx`

- [ ] **Step 1: 去重**

三个面板已在 Dock 内,移除各自顶部重复的"标题 + 关闭(X)"(关闭统一由 Dock 头部负责);`BrowserPanel` 移除自带的左边缘拖宽(改由 Dock 统一拖宽);地址栏/前进后退保留。`onClose` 仍保留以兼容 Dock 头部调用(Dock 头部 X 调 `onClose`),但面板内部不再渲染自己的 X。逐个改、逐个 `pnpm dev` 验收,避免一次动太多。

- [ ] **Step 2: typecheck + 手动验收 + 提交**

```bash
git add -A
git commit -m "refactor(ui): Dock 内面板去掉重复外框/关闭/拖宽"
```

### Task 6.3:暗/亮主题、键盘可达性、空态核对

- [ ] **Step 1: 核对清单(手动验收,`pnpm dev`)**
  - 暗色 / 亮色(Settings→General 切换)下:顶栏、分段、Dock 标签、分隔条对比度正常。
  - 键盘:分段开关、Dock 标签、关闭按钮、分隔条(`role=separator` + tabIndex)可聚焦操作;左栏拖宽箭头键仍可用。
  - 空 workspace → WelcomeScreen 不受影响(无 TopBar/Dock)。
  - `pnpm lint` 全绿;`pnpm test` 全绿;`pnpm typecheck` 全绿。

- [ ] **Step 2: 收尾提交**

```bash
git add -A
git commit -m "chore(ui): 主题/键盘/空态核对与收尾"
```

---

## Self-Review(作者自检结果)

- **Spec 覆盖**:①聊天压缩→Phase 4(Dock 取代 70/30,对话恒 flex-1)+ Phase 5(居中列);②面板抢位→Phase 4(统一 Dock 标签);③左栏只有文件树→Phase 3(LeftRail 分段 + ChatHistoryPanel);④顶栏浪费→Phase 2(TopBar);⑤太 IDE→Phase 5 居中列 + Phase 2 顶栏 + Phase 6 留白/主题。会话上提→Phase 1。几何/窄窗→Phase 0 + 4。均有对应任务。
- **占位符**:无 "TODO/TBD";可视化步骤显式标"手动验收"并给出确认清单,非占位。
- **类型一致**:`DockTab`、`DockMode`、`resolveDockMode`/`clampDockWidth`/`clampRailWidth` 命名在各任务间一致;`ContextDock` props 与 App 传参一致;`useChatSessionContext()` 返回沿用 `useChatSession` 既有字段(`sessions/activeSessionId/handleNewChat/handleSelectSession/handleDeleteSession/selectedLlmConfigId/setSelectedLlmConfigId/isLoading`)。
- **风险提示**:Phase 1 为纯搬移并独立验收;Phase 2/3 对大文件采用"精确锚点删除"而非整文件重写,降低回归面。
