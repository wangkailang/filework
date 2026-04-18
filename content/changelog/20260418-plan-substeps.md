---
title: 2026-04-18 计划子步骤与执行明细优化
---

# 计划子步骤与执行明细优化

Date: 2026-04-18
Author: AI Assistant
Type: Feature / UX / Reliability

## Summary

为复杂多步骤计划增加子步骤明细（subSteps），让用户在执行前和执行中都能清楚了解每个步骤的具体操作。同时修复计划 JSON 解析不鲁棒导致的单步退化问题，改善超时/失败时的错误信息。

## Motivation

复杂任务（如"总结文章 + 生成 PPT"）执行时存在三个问题：

1. **步骤无明细**：计划只有粗粒度的步骤列表（如"扫描目录"、"生成 PPT"），用户无法了解每个步骤内部在做什么
2. **计划不拆分**：LLM 用完工具调用步数后未输出 JSON，导致退化为单步 "execute — 原始 prompt"
3. **错误信息不明确**：超时只显示"步骤超时 (300s)，已自动跳过"，没有说明当时在做什么

## Changes

### 1. 数据模型 — PlanSubStep

**修改 `src/main/planner/types.ts`**

新增 `PlanSubStep` 接口和 `PlanStep.subSteps` 字段：

```typescript
export interface PlanSubStep {
  label: string;           // 具体操作描述
  status: "pending" | "done";
}

export interface PlanStep {
  // ...existing fields
  subSteps?: PlanSubStep[];
}
```

`PlannerLLMOutput` 同步支持 `subSteps?: string[]`。

### 2. Planner 提示词优化

**修改 `src/main/planner/index.ts`**

- 限制工作区探索在 2-3 次工具调用内，防止用完步数后无法输出 JSON
- 要求复杂任务拆分为 3-7 步，禁止单步输出
- 提供子步骤正反例：
  - BAD: "查看文件内容", "评估质量"
  - GOOD: "读取 report.md 提取章节标题", "按时间线重组第3-5节"

### 3. JSON 解析鲁棒性

**修改 `src/main/planner/index.ts`**

新增 `extractPlanJson` 依次尝试 4 种提取策略：

1. ` ```json ``` ` 围栏
2. ` ``` ``` ` 裸围栏
3. 锚定 `"steps"` 关键词的大括号提取
4. 整段文本直接解析

每种策略通过 `isValidPlanOutput` 校验结构（必须有 `steps` 数组且非空），防止非法对象导致崩溃。

新增 `buildFallbackPlan`：当所有解析失败时，基于 prompt 关键词（URL、总结、生成、PPT）自动拆分为多步计划。

### 4. Executor 子步骤追踪

**修改 `src/main/planner/executor.ts`**

- 将子步骤注入 step prompt，让 LLM 知道需要完成哪些子任务
- 基于 tool-call 完成数发送 `ai:plan-substep-progress` IPC 事件
- 进度上限为 `totalSubSteps - 1`，最后一个子步骤仅在步骤成功时标记完成
- 相同 completed 值不重复发送（`lastEmittedCompleted` 去重）
- 超时/失败错误信息包含最后执行的工具名和部分输出
- 提取 `truncateText` 工具函数消除 3 处重复截断逻辑
- `resultSummary` 从 200 字符提升至 500 字符

### 5. 可展开步骤 UI

**修改 `src/renderer/components/ai-elements/plan-viewer.tsx`**

- 新增 `PlanSubStepView` 类型和 `SubStepList` 组件
- 包含子步骤的步骤可点击展开/折叠（`<button>` + `ChevronDown/Right`）
- 运行中和失败的步骤自动展开
- 子步骤图标状态：
  - `done` → 绿色勾
  - 运行中首个 pending → 蓝色 spinner
  - 失败步骤中的 pending → 红色叉号 + 删除线
  - 其他 pending → 灰色圆圈
- `firstPendingIdx` 预计算，消除 O(n²) 查找

### 6. IPC 与渲染器

**修改 `src/preload/index.ts` + `src/renderer/components/chat/useChatSession.ts`**

- 新增 `onPlanSubStepProgress` IPC 桥接
- 子步骤进度处理器使用单次 `setMessages` 直接更新，修复之前双重 `setMessages` 导致的无效渲染 bug

### 7. 计划文件

**修改 `src/main/planner/plan-file.ts`**

`.filework/task_plan.md` 现在渲染子步骤检查列表：

```
✅ **Step 1: 分析现有文件** — 检查已存在的原始文章、总结文档和PPT文件
   - ✅ 读取 article.md 提取章节标题
   - ✅ 检查 summary.md 完整性
   - ⬜ 验证 PPT 文件格式
```

## Files Changed

| 文件 | 改动 |
|------|------|
| `src/main/planner/types.ts` | 新增 PlanSubStep 接口 |
| `src/main/planner/index.ts` | Planner prompt、JSON 解析、兜底计划 |
| `src/main/planner/executor.ts` | 子步骤追踪、上下文错误、truncateText |
| `src/main/planner/plan-file.ts` | 子步骤 Markdown 渲染 |
| `src/preload/index.ts` | onPlanSubStepProgress IPC |
| `src/renderer/.../plan-viewer.tsx` | SubStepList 组件、展开 UI |
| `src/renderer/.../useChatSession.ts` | 子步骤进度事件处理 |
