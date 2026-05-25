# Workspace Agent

> 通用的本地 AI Agent — 在你选定的工作区里读写文件、运行命令、调用扩展技能。

> ℹ️ 仓库 / npm 包名 / preload 命名空间 / 用户数据目录仍沿用历史标识符 `filework`，未做技术性重命名以避免破坏已有用户数据与 macOS 代码签名身份。仅 UI / 文档层面统一为 "Workspace Agent"。

## Features

- 🤖 **通用 Agent** — 默认就具备读 / 写 / 列文件、运行 shell、向用户追问的能力，不局限于文件场景
- 🗂️ **文件类技能内置** — 文件整理、PDF / Excel / Word 解析、报告生成等以扩展形式开箱即用
- ⚡ **原生加速** — 重复文件检测、目录统计、增量扫描等 IO/CPU 密集操作由 Rust 原生插件(`@filework/native`)处理，大目录下并行扫描不阻塞界面
- 🌿 **Git 项目管理** — 本地 Git 分支切换与 diff 预览，GitHub / GitLab 仓库克隆、PR / MR、CI 状态与日志查看
- 🔗 **MCP 支持** — 接入任意 Model Context Protocol 服务器，把其工具桥接给 Agent 调用
- 📋 **计划执行** — 复杂任务自动拆步、可视化每步进度、敏感操作前用户审批
- 🔒 **数据本地** — 会话历史 / 配置 / 缓存全部在本地，模型 API 是唯一可选的外部依赖
- 🔌 **多 LLM 后端** — OpenAI / Claude / DeepSeek / Ollama / 任何 OpenAI-兼容端点

## Tech Stack

- Electron (桌面壳)
- React + Tailwind CSS (UI)
- SQLite + Drizzle ORM (本地数据库)
- Vercel AI SDK (多 AI 后端)
- Rust + napi-rs (`@filework/native` 原生插件，承担 IO/CPU 密集的文件系统操作)
- electron-builder (macOS 打包)

## Development

> 前置依赖:Node.js + pnpm，以及 **Rust 工具链**(`rustup`)。`pnpm install`
> 的 `postinstall` 会自动编译原生插件 `@filework/native`,缺少 Rust 会导致安装失败。

```bash
# Install dependencies(同时会编译 @filework/native)
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
│   ├── native/     # @filework/native 的 TS 封装(懒加载原生插件)
│   └── ipc/        # IPC handlers (file ops, AI, settings)
├── preload/        # Context bridge (main ↔ renderer)
└── renderer/       # React UI
    ├── components/ # UI components
    │   ├── chat/   # Chat interface
    │   ├── layout/ # Sidebar, titlebar
    │   └── onboarding/ # Welcome screen
    └── global.css  # Design tokens

native/
└── filework-native/  # Rust 原生插件 (napi-rs),处理 IO/CPU 密集操作
    └── src/
        ├── walker.rs # 递归遍历(供 dedup / stats 复用)
        ├── dedup.rs  # 重复文件检测(blake3 + rayon 并行哈希)
        ├── stats.rs  # 目录统计(文件/目录数、大小、扩展名直方图)
        └── scan.rs   # 单层目录扫描(并行 stat,供增量扫描器使用)
```

文件系统的重活已下沉到原生插件:重复文件检测、目录统计(`fs:directoryStats`)、
增量扫描的单层目录读取。缓存编排等有状态逻辑仍留在 TS 端。
