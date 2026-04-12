# Skills System

## Overview

**FileWork's AI capabilities are organized around a skill-based architecture where each skill provides specific file/data processing capabilities.**

A **skill** is a self-contained module that defines:
- Specific AI tools and capabilities
- System prompts for behavior guidance
- Keywords for automatic skill matching
- Category classification (tool vs task)

## Built-in Skills

| Skill              | Category | Purpose                           | Keywords                    |
| ------------------ | -------- | --------------------------------- | --------------------------- |
| **file-organizer** | task     | Organize files by type/date/size  | organize, sort, clean       |
| **report-generator** | task   | Generate directory analysis       | report, analyze, summary    |
| **data-processor** | task     | CSV/JSON/Excel processing         | convert, merge, process     |
| **content-search** | tool     | Search within file contents       | search, find, grep         |
| **duplicate-finder** | tool   | Find duplicate files             | duplicate, same, copy      |
| **project-scaffolder** | task | Create project templates          | create, scaffold, template |
| **pdf-processor**  | tool     | Extract text/data from PDFs      | pdf, extract, read        |
| **xlsx-processor** | tool     | Process Excel files              | excel, xlsx, spreadsheet  |
| **docx-processor** | tool     | Process Word documents           | word, docx, document      |

## Skill Structure Pattern

**Reference Implementation:** `src/main/skills/file-organizer.ts`

```typescript
// src/main/skills/{skill-name}.ts
import type { Skill } from "./types";

export const mySkill: Skill = {
  id: "my-skill",
  name: "My Skill",
  description: "What this skill does",
  keywords: ["keyword1", "keyword2"],
  category: "tool" | "task",  // tool = read-only, task = side effects
  systemPrompt: `System instructions for AI when using this skill...`,
  tools: {
    myTool: {
      description: "Tool description",
      parameters: z.object({
        param: z.string()
      }),
      execute: async ({ param }) => {
        // Tool implementation
        return { result: "..." };
      }
    }
  },
  suggestions: [
    "Example prompt 1",
    "Example prompt 2"
  ]
};
```

## Skills Runtime (Protected)

**🚨 CRITICAL: `src/main/skills-runtime/` is the core execution engine. DO NOT modify unless explicitly requested.**

The skills runtime handles:
- Skill registration and discovery
- Prompt matching and scoring
- Tool execution and security
- External skill loading
- Skill lifecycle management

**Only modify skills-runtime if user specifically says:**
- "修改 skills runtime"
- "change skills execution engine"
- "modify skill registry"

## Adding a New Skill

1. **Create skill file**: `src/main/skills/my-skill.ts`
2. **Define skill interface**: Follow `Skill` type pattern
3. **Implement tools**: Define tools with Zod schemas
4. **Register skill**: Add to `src/main/skills/index.ts`
5. **Test skill**: Create tests in `__tests__/`
6. **Update documentation**: Add to skills table above