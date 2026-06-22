# AI Integration

## Multi-LLM Support

**Supported Providers:**
- OpenAI (GPT-4, GPT-4 Turbo, GPT-3.5)
- Anthropic (Claude 3.5 Sonnet, Claude 3 Haiku)
- DeepSeek (DeepSeek Coder, DeepSeek Chat)
- Ollama (local models via Ollama server)
- MiniMax (chat/image/video configurations)
- Xiaomi MiMo
- OpenAI Compatible custom endpoints
- GitHub Copilot

Configuration flow, connection testing, model discovery, Copilot device
authorization, and runtime selection rules are documented in
[LLM Configuration and Usage](./llm-configuration.md).

## Message Flow

```
User Input → Skill Matching → Tool Selection → AI Generation → Tool Execution → Response
```

**Key Files:**
- `src/main/ipc/ai-handlers.ts` - Main AI orchestration
- `src/main/ai/message-converter.ts` - Message format conversion
- `src/main/ai/token-budget.ts` - Token usage management
- `src/main/ipc/ai-tools.ts` - Tool definitions and execution

## AI Tool Pattern

```typescript
export const myTool = {
  description: "What this tool does",
  parameters: z.object({
    path: z.string().describe("File path to process"),
    options: z.object({
      recursive: z.boolean().default(false)
    }).optional()
  }),
  execute: async ({ path, options = {} }) => {
    // Implementation
    return {
      success: true,
      data: processedResult
    };
  }
};
```

## MCP 认证

MCP server 由主进程管理,连接成功后会暴露为 agent 工具。HTTP MCP
认证支持自动 OAuth 发现、手动 OAuth 兜底和静态 headers;stdio MCP
server 继续使用自身的环境变量凭据。

实现流程、配置示例和验证清单见 [MCP 认证](./mcp-authentication.md)。

## Tech Stack

**Frontend & UI:**
- React 19+ (functional components + hooks)
- TypeScript (strict mode)
- Tailwind CSS 4 (utility-first)
- Lucide React (icons)
- Sonner (toast notifications)

**Backend & Data:**
- Electron (desktop app framework)
- SQLite + Drizzle ORM (local database)
- Zod (runtime validation)
- AI SDK (multi-provider AI support)
- better-sqlite3 (native SQLite bindings)

**Development:**
- Vite (bundling via electron-vite)
- Vitest (testing)
- Biome (linting & formatting)
- TypeSafe i18n (internationalization)

## Design System Adherence

**UI components must use design tokens from `global.css`:**

```css
/* src/renderer/global.css - Design tokens */
:root {
  --color-primary: #2563eb;
  --color-surface: #ffffff;
  --spacing-md: 0.75rem;
  --radius-sm: 0.375rem;
}
```

**Component Pattern:**
```tsx
// ✅ CORRECT: Use CSS custom properties
<div className="bg-surface text-foreground p-spacing-md rounded-radius-sm">

// ❌ WRONG: Hardcoded Tailwind values
<div className="bg-white text-gray-900 p-3 rounded-md">
```

## Modifying AI Behavior

1. **Skill-specific**: Edit `systemPrompt` in skill definition
2. **Global behavior**: Modify prompts in `ai-handlers.ts`
3. **Tool permissions**: Update `ai-tool-permissions.ts`
4. **New tools**: Add to `ai-tools.ts` with proper schemas
