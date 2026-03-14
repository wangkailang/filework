# FileWork

> 你的本地文件 AI 助手 — 告诉它做什么，它就在你的目录里开始工作。

## Features

- 🗂️ **智能整理** — 按类型、日期、大小自动分类文件
- 📊 **报告生成** — 分析目录内容，生成结构化报告
- 🔄 **数据处理** — CSV/JSON/Excel 转换、合并、清洗
- 🔍 **内容搜索** — 在文件内容中搜索，AI 总结关键信息
- 🔒 **数据本地** — 所有文件操作在本地完成，数据不离开你的电脑
- 🤖 **AI 可选** — 支持 OpenAI、Claude、Ollama 本地模型

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
