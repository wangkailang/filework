# FileWork Design System

> **Purpose**: Design tokens & patterns for FileWork desktop app
> **Last Updated**: 2026-03-09
> **Owner**: Design Team

---

## Design Principles

1. **桌面原生感**: 遵循 macOS 设计规范，不像 Web 应用
2. **信息密度适中**: 桌面端可以展示更多信息，但不过载
3. **暗色优先**: 开发者和知识工作者偏好暗色主题
4. **操作可见**: 文件操作过程实时可见，给用户安全感

---

## Color Palette

### 默认色板

通过 CSS 变量实现主题切换。

| Token | Light | Dark | Usage |
|-------|-------|------|-------|
| `--background` | `#ffffff` | `#0a0a0a` | 主背景 |
| `--foreground` | `#0a0a0a` | `#fafafa` | 主文字 |
| `--primary` | `#2563eb` | `#3b82f6` | 主操作色 |
| `--muted` | `#f5f5f5` | `#262626` | 次要背景 |
| `--accent` | `#f5f5f5` | `#262626` | 强调背景 |
| `--destructive` | `#ef4444` | `#ef4444` | 危险操作 |

### FileWork 特有色彩

| Token | Value | Usage |
|-------|-------|-------|
| `--file-folder` | `#f59e0b` | 文件夹图标 |
| `--file-code` | `#3b82f6` | 代码文件图标 |
| `--file-doc` | `#10b981` | 文档文件图标 |
| `--file-image` | `#8b5cf6` | 图片文件图标 |
| `--file-data` | `#f97316` | 数据文件图标 |
| `--ai-thinking` | `#6366f1` | AI 思考状态 |
| `--ai-success` | `#22c55e` | AI 完成状态 |

---

## Typography

| Token | Value | Usage |
|-------|-------|-------|
| `--font-sans` | `system-ui, -apple-system, sans-serif` | 界面文字 |
| `--font-mono` | `SF Mono, Menlo, monospace` | 文件路径、代码 |
| `--text-xs` | `12px` | 辅助信息 |
| `--text-sm` | `14px` | 正文 |
| `--text-base` | `16px` | 标题 |
| `--text-lg` | `18px` | 大标题 |

---

## Spacing

沿用 Tailwind 的 4px 基准网格。

---

## Components

### Chat Input
- 底部固定，类似 ChatGPT 的输入框
- 支持多行输入
- 发送按钮 + 快捷键 (Cmd+Enter)
- 上方显示当前工作目录

### File Tree
- 左侧面板，可折叠
- 显示当前工作目录的文件树
- 文件类型图标 + 颜色编码
- 右键菜单支持常用操作

### Task Card
- 显示任务状态 (思考中 / 执行中 / 完成 / 失败)
- 展示 AI 的操作步骤
- 可展开查看详细日志
- 支持撤销操作

### Settings Panel
- AI 配置 (provider, model, API key)
- 工作目录管理
- 语言切换
- 主题切换 (light/dark/system)
