# Coding Agent Instructions

This file provides guidance to AI Coding Agents including Claude Code, GitHub Copilot, Cursor, and other coding assistants when working with the FileWork codebase.

## 🚨 BEFORE YOU SAY "DONE" - MANDATORY CHECKLIST

**Check these rules before finishing ANY coding task:**

| Rule                     | Trigger                    | Action                                          |
| ------------------------ | -------------------------- | ----------------------------------------------- |
| 🔍 **Typecheck**          | Modified 3+ files          | Run `pnpm typecheck` → Fix ALL errors          |
| 🎨 **Lint & Format**      | Any code changes           | Run `pnpm lint` → Fix all errors               |
| 🧪 **Tests**              | Modified core logic        | Run `pnpm test` → Ensure tests pass            |
| 📦 **Build**              | Modified main/renderer     | Run `pnpm build` → Verify successful build     |
| 🚫 **No Skills Runtime**  | Touching `skills-runtime/` | STOP! Only if explicitly requested by user     |

**Not optional. Confirm applicable checks completed.**

---

## Project Overview

**FileWork** is a local directory AI assistant built with Electron + React. It helps users organize files, generate reports, manage projects, research content, and process data through natural language commands.

**Key characteristics:**
- Electron desktop application with React frontend
- TypeScript throughout with strict type checking
- SQLite database with Drizzle ORM for local data
- Multi-LLM support (OpenAI, Claude, DeepSeek, Ollama)
- Skill-based extensibility system for AI capabilities
- Local-first approach with no cloud data transmission

## Essential Commands

### Development
```bash
pnpm install              # Install dependencies
pnpm dev                  # Start development server
pnpm build                # Build for production
pnpm start                # Start production build
pnpm package              # Package for macOS

pnpm lint                 # Biome format & lint
pnpm typecheck            # TypeScript type checking
pnpm test                 # Run all tests with Vitest
pnpm test:watch           # Watch mode for tests

pnpm typesafe-i18n        # Generate i18n types
```

### Troubleshooting
```bash
rm -rf node_modules pnpm-lock.yaml && pnpm install  # Dependency issues
pnpm postinstall          # Electron rebuild
rm -rf ~/.config/Electron # Clear Electron cache
```

## Architecture Overview

### Repository Structure
```
filework/
├── src/
│   ├── main/                # Electron main process (Node.js)
│   │   ├── db/             # SQLite database + Drizzle ORM
│   │   ├── ipc/            # IPC handlers (AI, files, settings)
│   │   ├── ai/             # AI utilities (message conversion, tokens)
│   │   ├── skills/         # 🎯 Built-in skills (file ops, data processing)
│   │   ├── skills-runtime/ # 🚨 PROTECTED: Skill execution engine
│   │   ├── planner/        # Task planning and execution
│   │   └── index.ts        # Electron main entry point
│   ├── preload/           # Context bridge (security layer)
│   └── renderer/          # React frontend
│       ├── components/    # UI components
│       ├── config/       # App configuration
│       ├── types/        # TypeScript type definitions
│       └── global.css    # Tailwind + design tokens
├── out/                  # Build output
├── dist/                 # Packaged app output
└── locales/             # i18n translations
```

## Critical Rules

### 🚨 1. DO NOT MODIFY skills-runtime

**`src/main/skills-runtime/` contains the core skill execution engine used by all skills.**

- Only modify if user explicitly requests skills-runtime changes
- For new skills: Create in `src/main/skills/` directory
- For skill modifications: Edit existing skill files
- For AI behavior: Modify system prompts in skill definitions

### 🎯 2. Skill Categories Must Be Correct

**Skills MUST be categorized correctly:**

- **"tool"**: Read-only operations (search, extract, analyze)
- **"task"**: Operations that modify filesystem (write, organize, create)

### 🔒 3. Security & Privacy

**FileWork is local-first with strong privacy guarantees:**

- ✅ All data processing happens locally
- ✅ No file data sent to external services (except optional AI APIs)
- ✅ User controls AI provider choice
- ❌ Never log or transmit file contents
- ❌ Never store API keys in plaintext

## Documentation Index

For detailed information, see the docs directory:

- **[Skills System](docs/skills-system.md)** - Complete skills architecture, patterns, and development guide
- **[Data Architecture](docs/data-architecture.md)** - Database schema, types, and patterns
- **[AI Integration](docs/ai-integration.md)** - Multi-LLM support, message flow, and tool patterns
- **[Testing Guidelines](docs/testing.md)** - Test structure, patterns, and best practices
- **[Common Workflows](docs/workflows.md)** - Step-by-step guides for common development tasks
- **[Debugging Guide](docs/debugging.md)** - Common issues, tools, and troubleshooting

## Key Patterns to Remember

1. **Skills are self-contained** - Each skill defines its own tools and behavior
2. **Type safety everywhere** - Use Zod for runtime validation, TypeScript for compile time
3. **Local-first architecture** - No cloud dependencies except optional AI APIs
4. **IPC for main↔renderer** - All communication via typed IPC handlers
5. **Design token consistency** - Use CSS custom properties, never hardcode values
6. **Test coverage for core logic** - Especially skills and AI utilities
7. **Security by default** - Encrypt sensitive data, validate all inputs
8. **Skill categories matter** - Tool vs Task affects user experience and security