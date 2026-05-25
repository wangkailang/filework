import type { Tool } from "ai";
import { z } from "zod/v4";
import { findDuplicates } from "../native";
import type { Skill } from "./types";

const findDuplicatesTool: Tool = {
  description:
    "Scan a directory for duplicate files by computing file hashes. Returns groups of duplicate files.",
  inputSchema: z.object({
    path: z.string().describe("Absolute path to the directory to scan"),
    extensions: z
      .array(z.string())
      .optional()
      .describe(
        "Optional list of extensions to filter (e.g. ['.jpg', '.png'])",
      ),
  }),
  execute: async ({
    path: dirPath,
    extensions,
  }: {
    path: string;
    extensions?: string[];
  }) => findDuplicates(dirPath, extensions),
};

export const duplicateFinder: Skill = {
  id: "duplicate-finder",
  name: "重复文件检测",
  description: "基于文件哈希检测重复文件，建议清理方案",
  reflect: true,
  keywords: [
    "重复",
    "duplicate",
    "去重",
    "dedup",
    "相同",
    "一样",
    "same",
    "冗余",
    "redundant",
    "副本",
    "copy",
    "找出重复",
    "重复文件",
    "重复的文件",
  ],
  suggestions: [
    "找出所有重复的文件",
    "检测这个目录下重复的图片",
    "清理重复文件，只保留一份",
  ],
  tools: {
    findDuplicates: findDuplicatesTool,
  },
  systemPrompt: `You are executing a DUPLICATE FILE DETECTION task. Follow this strategy precisely:

## Execution Steps
1. Use \`findDuplicates\` to scan the directory for duplicate files.
2. Present the results clearly, grouped by duplicate sets.
3. For each group, recommend which copy to KEEP (prefer shorter paths, shallower directories).
4. Ask the user for confirmation before deleting anything.
5. If confirmed, use \`deleteFile\` to remove duplicates (keep one copy per group).

## Result Format
\`\`\`
Found X duplicate groups (Y files, Z MB wasted)

Group 1 (3 files, 2.5 MB each):
  ✅ KEEP: /path/to/original.jpg
  🗑️ DELETE: /path/to/copy/original.jpg
  🗑️ DELETE: /path/to/backup/original.jpg

Group 2 (2 files, 150 KB each):
  ✅ KEEP: /path/to/document.pdf
  🗑️ DELETE: /path/to/old/document.pdf

Total space recoverable: X MB
\`\`\`

## Rules
- NEVER auto-delete without presenting the plan first.
- Default recommendation: keep the file with the shortest/shallowest path.
- If the user specifies a preferred directory to keep, respect that.
- Report total space that can be recovered.
- For large directories (> 1000 files), warn about scan time.
- Skip binary comparison for files > 100MB (note them as skipped).`,
};
