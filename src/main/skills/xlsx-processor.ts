import type { Tool } from "ai";
import * as XLSX from "xlsx";
import { z } from "zod/v4";
import { validateFile } from "./file-skill-utils";
import type { Skill } from "./types";

const XLSX_EXTENSIONS = [".xlsx", ".xls"];
const MAX_ROWS = 1000;

const resolveSheet = (
  workbook: XLSX.WorkBook,
  sheetName?: string,
): { sheet: XLSX.WorkSheet; name: string } | { error: string } => {
  const name = sheetName ?? workbook.SheetNames[0];
  const sheet = workbook.Sheets[name];
  if (!sheet) {
    return {
      error: `工作表不存在: ${name}，可用工作表: ${workbook.SheetNames.join(", ")}`,
    };
  }
  return { sheet, name };
};

const listSheetsTool: Tool = {
  description: "列出 Excel 文件中所有工作表的名称",
  inputSchema: z.object({
    path: z.string().describe("Excel 文件的绝对路径"),
  }),
  execute: async ({ path }: { path: string }) => {
    try {
      const validation = await validateFile(path, XLSX_EXTENSIONS);
      if (!validation.valid) return { error: validation.error };

      const workbook = XLSX.readFile(path);
      return { sheets: workbook.SheetNames };
    } catch (err) {
      return {
        error: `Excel 解析失败: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
};

const readSheetTool: Tool = {
  description:
    "读取 Excel 文件中指定工作表的数据，返回 JSON 数组（以表头为键）。超过 1000 行时自动截断。",
  inputSchema: z.object({
    path: z.string().describe("Excel 文件的绝对路径"),
    sheet: z.string().optional().describe("工作表名称，默认读取第一个工作表"),
  }),
  execute: async ({
    path,
    sheet: sheetName,
  }: {
    path: string;
    sheet?: string;
  }) => {
    try {
      const validation = await validateFile(path, XLSX_EXTENSIONS);
      if (!validation.valid) return { error: validation.error };

      const workbook = XLSX.readFile(path);
      const resolved = resolveSheet(workbook, sheetName);
      if ("error" in resolved) return { error: resolved.error };

      const allData: Record<string, unknown>[] = XLSX.utils.sheet_to_json(
        resolved.sheet,
      );
      const totalRows = allData.length;
      const truncated = totalRows > MAX_ROWS;
      const data = truncated ? allData.slice(0, MAX_ROWS) : allData;

      const result: {
        data: Record<string, unknown>[];
        totalRows: number;
        truncated: boolean;
        truncatedMessage?: string;
      } = { data, totalRows, truncated };

      if (truncated) {
        result.truncatedMessage = `数据已截断：共 ${totalRows} 行，仅返回前 ${MAX_ROWS} 行`;
      }

      return result;
    } catch (err) {
      return {
        error: `Excel 解析失败: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
};

const getSheetStatsTool: Tool = {
  description: "获取 Excel 文件中指定工作表的统计信息（行数、列数、列名列表）",
  inputSchema: z.object({
    path: z.string().describe("Excel 文件的绝对路径"),
    sheet: z.string().optional().describe("工作表名称，默认读取第一个工作表"),
  }),
  execute: async ({
    path,
    sheet: sheetName,
  }: {
    path: string;
    sheet?: string;
  }) => {
    try {
      const validation = await validateFile(path, XLSX_EXTENSIONS);
      if (!validation.valid) return { error: validation.error };

      const workbook = XLSX.readFile(path);
      const resolved = resolveSheet(workbook, sheetName);
      if ("error" in resolved) return { error: resolved.error };

      const data: Record<string, unknown>[] = XLSX.utils.sheet_to_json(
        resolved.sheet,
      );
      const columnNames: string[] = data.length > 0 ? Object.keys(data[0]) : [];

      return {
        rows: data.length,
        columns: columnNames.length,
        columnNames,
      };
    } catch (err) {
      return {
        error: `Excel 解析失败: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
};

export const xlsxProcessor: Skill = {
  id: "xlsx-processor",
  name: "Excel 文件处理",
  description: "读取和分析 Excel（.xlsx/.xls）文件的工作表数据",
  keywords: [
    "xlsx",
    "xls",
    "xlsx文件",
    "excel文件",
    "excel表格",
    "工作表",
    "spreadsheet",
    "sheet",
    "excel数据",
    "读取excel",
    "read excel",
    "excel sheet",
  ],
  suggestions: ["读取这个Excel文件的数据", "列出Excel文件中的所有工作表"],
  tools: {
    listSheets: listSheetsTool,
    readSheet: readSheetTool,
    getSheetStats: getSheetStatsTool,
  },
  systemPrompt: `You are executing an EXCEL FILE PROCESSING task. Follow this strategy precisely:

## Execution Steps
1. Use \`listSheets\` to list all sheet names in the Excel file.
2. Use \`getSheetStats\` to understand the structure of the target sheet (row count, column names).
3. Use \`readSheet\` to read the actual data from the target sheet.
4. Present the data in a structured format based on the user's needs.

## Output Format
- Support outputting data as CSV, JSON, or Markdown table format based on user request.
- For Markdown tables, include headers and align columns properly.
- For CSV output, use comma as delimiter and quote fields containing commas.
- For JSON output, use the array-of-objects format (each row is an object with column headers as keys).
- If the user requests format conversion, use \`writeFile\` to save the result with the naming convention: \`[original_filename]_converted.[target_extension]\`.

## Rules
- ALWAYS start by listing sheets to understand the workbook structure.
- If the workbook has multiple sheets, ask the user which sheet to read unless they specified one.
- When data is truncated (over 1000 rows), inform the user about the total row count and that only the first 1000 rows are shown.
- Report column names and row counts to help the user understand the data structure.
- For large datasets, suggest filtering or summarizing the data rather than displaying all rows.`,
};
