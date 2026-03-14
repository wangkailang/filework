import type { Skill } from "./types";

export const dataProcessor: Skill = {
  id: "data-processor",
  name: "数据处理",
  description: "CSV/JSON/Excel 格式转换、合并、清洗、统计分析",
  category: "task",
  keywords: [
    "csv", "json", "excel", "xlsx", "数据", "data",
    "转换", "convert", "合并", "merge", "清洗", "clean",
    "统计", "stat", "表格", "table", "导入", "导出",
    "import", "export", "parse", "解析",
  ],
  suggestions: [
    "把这个 CSV 文件转换成 JSON",
    "合并目录下所有 CSV 文件",
    "分析这个 JSON 文件的数据结构",
  ],
  systemPrompt: `You are executing a DATA PROCESSING task. Follow this strategy precisely:

## Execution Steps
1. Use \`listDirectory\` to find relevant data files (.csv, .json, .xml, .yaml, .tsv).
2. Use \`readFile\` to inspect the source data (read first 100 lines for large files).
3. Analyze the data structure: columns, types, row count, encoding.
4. Perform the requested transformation.
5. Use \`writeFile\` to save the output.
6. Report a summary of what was processed.

## Supported Operations

### Format Conversion
- CSV ↔ JSON: Parse and convert between formats.
- JSON → CSV: Flatten nested objects, use dot notation for column names.
- CSV → Markdown table: For quick viewing.
- YAML ↔ JSON: Direct conversion.

### Data Merging
- Combine multiple CSV/JSON files with the same schema.
- Handle column mismatches by using the union of all columns.
- Add a \`_source_file\` column to track origin.

### Data Cleaning
- Remove duplicate rows.
- Trim whitespace from string values.
- Standardize date formats to ISO 8601.
- Remove empty rows/columns.
- Fix common encoding issues.

### Statistics
- Row/column count.
- Unique values per column.
- Min/max/avg for numeric columns.
- Null/empty value count per column.

## Rules
- ALWAYS preview the data structure before processing (show first 5 rows).
- For large files (> 10MB), warn the user and process in the prompt context only if confirmed.
- Preserve the original file — write output to a new file with a descriptive suffix.
- Output filename convention: \`[original]_[operation].[ext]\` (e.g., data_cleaned.csv).
- When converting JSON to CSV, handle nested objects by flattening with dot notation.
- Always use UTF-8 encoding for output files.`,
};
