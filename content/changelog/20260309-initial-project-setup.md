---
title: 2026-03-09 Initial FileWork Project Setup
---

# Initial FileWork Project Setup

Date: 2026-03-09
Author: AI Assistant
AI Agent: Kiro

## Prompts & Instructions

**Original Request:**
> filework 使用 electron 搭建桌面端 APP，基于本地目录的 AI 助手

**Refined Instructions:**
- Electron 桌面应用
- AI 后端可配置 (OpenAI/Claude/Ollama/Custom)
- 保留多语言 (en/zh-CN/ja)
- 数据库使用 SQLite (better-sqlite3 + Drizzle ORM)
- 打包先做 macOS
- 包名 @filework/desktop
- 清理 changelog，构建 6 个 spec 文件

## What Changed
- Created Electron app skeleton (main/preload/renderer)
- SQLite database with Drizzle ORM schema
- IPC bridge for file operations, AI, and settings
- React UI: Welcome screen, Sidebar (file tree), Chat panel
- 6 spec files (PRD, ICP, marketing, onboarding, design-system, VI)
- i18n support (en, zh-CN, ja)
- electron-builder config for macOS

## Files Affected
- `filework/` — entire new project

## Breaking Changes
None (new project)

## Testing
- `pnpm dev` to start development
- Select a directory and test chat interface
