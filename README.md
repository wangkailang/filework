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

## Architecture

分层架构,数据流自上而下:UI → 唯一的 preload 桥 → 主进程 IPC → Agent 内核(工具注册表 + 审批门控)→ 平台服务 → 外部。

**分层说明**

- **① Renderer** — React + Tailwind 的纯 UI:对话区(回合交付 / 审批门控)、计划查看器、文件树与 Dock(预览 / diff / 网页)、设置(LLM 渠道、Workspace Memory 面板)。
- **② Preload** — `contextBridge` 暴露 `window.filework`,是主 ↔ 渲染之间**唯一**的桥,渲染层无 Node 权限。
- **③ Main / IPC** — 按域拆分的 handler:AI 与计划执行、文件 / Git / GitHub / GitLab、MCP、工作区记忆、配置与凭据。
- **④ Agent Core** — 智能体内核:
  - `agent-loop` 驱动「模型 → 工具调用 → 观测」循环,内置重试、反思门控(reflection-gate)、工具结果压缩 / 截断以控上下文。
  - `tool-registry` 统一注册工具并施加**审批门控**(敏感操作执行前需用户确认)。
  - **Tools** 是能力面:内置工具(读写文件、`runCommand`、目录统计)、**Memory 工具**(`updateMemory` 按 key upsert / `clearMemory` 分作用域清空,写入前做敏感信息拦截)、Web 工具(搜索 / 抓取)、技能执行(`run-skill`)、以及把任意 **MCP Server** 的工具桥接进来的 **MCP bridge**。
- **⑤ Platform / Services** — 工作区抽象(本地 / GitHub / GitLab)、内核沙箱(macOS seatbelt)、会话持久化(JSONL)、SQLite(Drizzle)、多后端 AI 适配层(Vercel AI SDK)、Rust 原生插件,以及**记忆存储**(`~/.filework/workspace-memory/*.json`,区分 `user` 跨工作区偏好与 `workspace` 项目事实)。
- **⑥ External** — 唯一的外部依赖面:LLM 厂商 API、MCP 服务器、Git 远端、本地文件系统。

> **记忆系统**:Agent 通过 Memory 工具把可复用事实写成结构化条目 `{ key, scope, category, text }`,同一 `key` 复用即原地更新(根治重复);读取时合并「人写 AGENTS.md / CLAUDE.md(只读)」+「机器记忆」注入系统提示。详见 `src/main/core/workspace/workspace-memory.ts`。

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
├── main/                 # Electron 主进程
│   ├── core/             # 与 Electron 解耦的内核
│   │   ├── agent/        # Agent 内核
│   │   │   ├── agent-loop.ts      # 模型 → 工具 → 观测 循环
│   │   │   ├── tool-registry.ts   # 工具注册 + 审批门控
│   │   │   └── tools/             # 内置工具(file ops / runCommand / memory / web / run-skill)
│   │   ├── workspace/    # 工作区抽象(local / github / gitlab)+ workspace-memory(机器记忆)
│   │   ├── session/      # 会话持久化(JSONL store)
│   │   └── sandbox/      # macOS seatbelt 内核沙箱
│   ├── mcp/              # MCP 客户端 + tool-bridge(把 MCP 工具桥接给 Agent)
│   ├── ai/               # AI 适配层(adapters)、上下文压缩、检索等
│   ├── db/               # SQLite (Drizzle ORM)
│   ├── native/           # @filework/native 的 TS 封装(懒加载原生插件)
│   └── ipc/              # IPC handlers(ai / plan / file / git / mcp / workspace-memory / settings …)
├── preload/              # Context bridge(main ↔ renderer 唯一桥)
└── renderer/             # React UI
    ├── components/       # chat / layout / dock / settings / onboarding
    └── global.css        # Design tokens

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
