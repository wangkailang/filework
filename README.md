# Workspace Agent

> 通用的本地 AI Agent — 在你选定的工作区里读写文件、运行命令、调用扩展技能。

> ℹ️ 仓库 / npm 包名 / preload 命名空间 / 用户数据目录仍沿用历史标识符 `filework`，未做技术性重命名以避免破坏已有用户数据与 macOS 代码签名身份。仅 UI / 文档层面统一为 "Workspace Agent"。

## Features

- 🤖 **通用 Agent** — 默认就具备读 / 写 / 列文件、运行 shell、向用户追问的能力，不局限于文件场景
- 🗂️ **文件类技能内置** — 文件整理、PDF / Excel / Word 解析、报告生成等以扩展形式开箱即用
- 📋 **计划执行** — 复杂任务自动拆步、可视化每步进度、敏感操作前用户审批
- 🔒 **数据本地** — 会话历史 / 配置 / 缓存全部在本地，模型 API 是唯一可选的外部依赖
- 🤖 **多 LLM 后端** — OpenAI / Claude / DeepSeek / Ollama / 任何 OpenAI-兼容端点

## Tech Stack

- Electron (桌面壳)
- React + Tailwind CSS (UI)
- SQLite + Drizzle ORM (本地数据库)
- Vercel AI SDK (多 AI 后端)
- electron-builder (macOS 打包)

## Development

```bash
# Install dependencies
pnpm install

# Start dev
pnpm dev

# Build
pnpm build

# Package for macOS
pnpm package
```

## Project Structure

```
src/
├── main/           # Electron main process
│   ├── db/         # SQLite database (Drizzle ORM)
│   └── ipc/        # IPC handlers (file ops, AI, settings)
├── preload/        # Context bridge (main ↔ renderer)
└── renderer/       # React UI
    ├── components/ # UI components
    │   ├── chat/   # Chat interface
    │   ├── layout/ # Sidebar, titlebar
    │   └── onboarding/ # Welcome screen
    └── global.css  # Design tokens
```
