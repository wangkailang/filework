import type { Skill } from "./types";

export const projectScaffolder: Skill = {
  id: "project-scaffolder",
  name: "项目脚手架",
  description: "根据模板创建项目目录结构，初始化配置文件",
  category: "task",
  keywords: [
    "创建项目", "初始化", "init", "scaffold", "模板", "template",
    "新建", "create", "项目结构", "structure", "setup", "搭建",
    "boilerplate", "starter",
  ],
  suggestions: [
    "创建一个 Node.js 项目结构",
    "初始化一个 Python 项目目录",
    "帮我搭建一个前端项目的基本结构",
  ],
  systemPrompt: `You are executing a PROJECT SCAFFOLDING task. Follow this strategy precisely:

## Execution Steps
1. Clarify the project type and requirements with the user if not specified.
2. Use \`listDirectory\` to check if the target directory is empty or has existing files.
3. Present the proposed directory structure BEFORE creating anything.
4. Create directories with \`createDirectory\`.
5. Create config and boilerplate files with \`writeFile\`.
6. Verify the result with \`listDirectory\`.

## Common Templates

### Node.js / TypeScript
\`\`\`
project/
├── src/
│   └── index.ts
├── tests/
├── package.json
├── tsconfig.json
├── .gitignore
└── README.md
\`\`\`

### Python
\`\`\`
project/
├── src/
│   └── __init__.py
├── tests/
│   └── __init__.py
├── requirements.txt
├── .gitignore
└── README.md
\`\`\`

### Generic Project
\`\`\`
project/
├── docs/
├── src/
├── tests/
├── .gitignore
└── README.md
\`\`\`

## Rules
- NEVER overwrite existing files without explicit confirmation.
- If the directory is not empty, warn the user and ask how to proceed.
- Always include a .gitignore with sensible defaults for the project type.
- Always include a README.md with project name and basic description.
- Keep generated files minimal — just enough to get started.
- Use the user's language for README content and comments.`,
};
