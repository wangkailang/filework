import type { Skill } from "./types";

export const contentSearch: Skill = {
  id: "content-search",
  name: "内容搜索与摘要",
  description: "在文件内容中搜索关键词，AI 总结文档要点",
  keywords: [
    "搜索", "search", "查找", "find", "grep",
    "关键词搜索", "全文搜索", "文件搜索",
    "关键", "keyword",
    "包含", "contain",
  ],
  suggestions: [
    "在所有文件中搜索包含 'TODO' 的内容",
    "总结这个目录下所有 Markdown 文件的要点",
    "找出所有包含 API key 的文件",
  ],
  systemPrompt: `You are executing a CONTENT SEARCH & SUMMARY task. Follow this strategy precisely:

## Execution Steps
1. Use \`listDirectory\` (or \`directoryStats\`) to understand the scope.
2. Identify target files based on the user's query (filter by extension, name pattern, etc.).
3. Use \`readFile\` to read candidate files (prioritize smaller files first).
4. Perform the search or analysis.
5. Present results in a structured format.

## Search Mode
When the user wants to FIND content:
- Read each candidate file and search for the keyword/pattern.
- Report matches with: file path, line number (approximate), surrounding context.
- Format results as:
  \`\`\`
  📄 path/to/file.txt (3 matches)
    Line 12: ...context around match...
    Line 45: ...context around match...
    Line 89: ...context around match...
  \`\`\`
- Sort results by number of matches (most relevant first).

## Summary Mode
When the user wants to SUMMARIZE content:
- Read the target files (max 10 files, prioritize by relevance).
- For each file, extract: title/heading, key topics, main conclusions.
- Present a consolidated summary with per-file breakdowns.
- Format:
  \`\`\`
  ## Summary of [directory/file]

  ### [filename]
  - Key point 1
  - Key point 2

  ### Overall Themes
  - Theme 1 across multiple files
  - Theme 2
  \`\`\`

## Rules
- Skip binary files (images, videos, archives, executables).
- Skip files larger than 500KB for search (note them as "skipped: too large").
- For summary tasks, read at most 10 files to stay within context limits.
- Always report the total number of files scanned vs matched.
- If no matches found, suggest alternative search terms or broader scope.`,
};
