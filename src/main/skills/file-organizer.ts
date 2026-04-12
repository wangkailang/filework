import type { Skill } from "./types";

export const fileOrganizer: Skill = {
  id: "file-organizer",
  name: "文件整理",
  description: "按类型、日期、大小自动分类文件，批量重命名，清理空目录",
  category: "task",
  keywords: [
    "整理",
    "分类",
    "归类",
    "organize",
    "sort",
    "classify",
    "重命名",
    "rename",
    "按类型",
    "按日期",
    "按大小",
    "清理",
    "clean",
    "tidy",
    "归档",
    "archive",
  ],
  suggestions: [
    "帮我把这个目录的文件按类型分类",
    "按修改日期整理文件到年/月子目录",
    "把所有图片文件移到 images 目录",
  ],
  systemPrompt: `You are executing a FILE ORGANIZATION task. Follow this strategy precisely:

## Execution Steps
1. ALWAYS start with \`directoryStats\` to understand the directory composition.
2. Use \`listDirectory\` to get the full file listing.
3. Analyze the files and propose an organization plan BEFORE making any changes.
4. Present the plan to the user in a clear table format showing: current path → new path.
5. Execute the plan using \`createDirectory\` + \`moveFile\`.
6. Verify the result with a final \`listDirectory\`.

## Organization Strategies

### By file type (default)
Group files into directories by extension category:
- documents/ → .pdf, .doc, .docx, .txt, .md, .rtf, .odt
- images/ → .jpg, .jpeg, .png, .gif, .svg, .webp, .bmp, .ico
- videos/ → .mp4, .mov, .avi, .mkv, .webm
- audio/ → .mp3, .wav, .flac, .aac, .ogg
- code/ → .js, .ts, .py, .java, .go, .rs, .c, .cpp, .h
- data/ → .csv, .json, .xml, .yaml, .yml, .toml, .sql
- archives/ → .zip, .tar, .gz, .rar, .7z
- other/ → everything else

### By date
Group files into YYYY/MM directories based on modification date.

### By size
Group into: small (< 1MB), medium (1-100MB), large (> 100MB).

## Rules
- NEVER move files that are already in a correctly named subdirectory.
- NEVER touch hidden files/directories (starting with .).
- NEVER touch node_modules, .git, or other system directories.
- If a filename conflict exists at the destination, append a numeric suffix (e.g., file_1.txt).
- Always preserve the original file extension.
- Report a summary: X files moved, Y directories created.`,
};
