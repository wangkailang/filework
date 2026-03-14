# FileWork Product Design Document (PRD)

> **Last Updated**: 2026-03-09
> **Owner**: Product & Engineering Team
> **Status**: Initial Development

## Context & Vision

**Problem**: 人们每天花大量时间在本地文件管理上——整理文件、生成报告、处理数据、查阅资料。这些任务重复、琐碎，但又不可避免。现有的 AI 助手要么是云端的（隐私顾虑），要么不理解本地文件系统的上下文。

**Solution**: FileWork 是一个基于 Electron 的桌面端 AI 助手。用户授权一个本地工作目录后，用自然语言告诉它要做什么，它就在该目录下自主完成任务。所有数据留在本地，AI 只发送必要的上下文到 LLM API。

**Success Criteria**: 用户打开 FileWork，选择工作目录，输入一条自然语言指令，AI 在 30 秒内开始执行并产出可见结果。

---

## Core Features

### 1. 工作目录授权
- 用户选择一个本地目录作为工作区
- FileWork 获得该目录的读写权限
- 支持多个工作目录切换
- 目录树可视化展示

### 2. 自然语言任务执行
- 用户输入自然语言指令，AI 理解并执行
- 支持的任务类型：
  - **整理文件**: 按类型/日期/大小分类、去重、重命名
  - **生成报告**: 分析目录内容，生成 Markdown/PDF 报告
  - **管理项目**: 创建项目结构、初始化配置、管理依赖
  - **查阅资料**: 搜索文件内容、总结文档、提取关键信息
  - **处理数据**: CSV/JSON/Excel 转换、合并、清洗、统计

### 3. AI 后端可配置
- 支持 OpenAI API (GPT-4o, GPT-4o-mini)
- 支持 Anthropic API (Claude)
- 支持本地模型 (Ollama)
- 支持自定义 API endpoint (兼容 OpenAI 格式)
- 用户在设置中配置 API Key 和模型选择

### 4. 任务历史与回滚
- 所有文件操作记录在本地 SQLite 数据库
- 支持查看任务历史
- 支持撤销/回滚文件操作

### 5. 多语言支持
- 中文 (zh-CN)
- English (en)
- 日本語 (ja)

---

## Non-Goals (v0.1)
- 不做云端同步
- 不做多用户协作
- 不做付费/订阅系统
- 不做 Web 版本
- 不做移动端

---

## Technical Architecture

| Layer | Technology |
|-------|-----------|
| Desktop Shell | Electron |
| Renderer | React + Tailwind + ai-elements |
| Main Process | Node.js (file ops, AI calls, SQLite) |
| IPC | Electron contextBridge + ipcMain/ipcRenderer |
| Database | SQLite (better-sqlite3 + Drizzle ORM) |
| AI | Vercel AI SDK (multi-provider) |
| Packaging | electron-builder (macOS first) |

---

## Data Flow

```
User Input (自然语言)
    ↓
Renderer (React UI)
    ↓ IPC
Main Process (Node.js)
    ↓
AI Provider (OpenAI/Claude/Ollama)
    ↓
Tool Execution (文件操作)
    ↓
Result → UI Update
```
