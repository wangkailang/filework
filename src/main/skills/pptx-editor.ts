import type { Tool } from "ai";
import { z } from "zod/v4";

import {
  editPptxPresentation,
  inspectPptxPresentation,
} from "../presentation/pptx";
import { validateFile } from "./file-skill-utils";
import type { Skill } from "./types";

const inspectPptxObjectsTool: Tool = {
  description:
    "检查 PPTX 的幻灯片、形状和文本 run，返回可用于精确编辑的稳定 objectId",
  inputSchema: z.object({
    path: z.string().describe("PPTX 文件的绝对路径"),
    search: z
      .string()
      .optional()
      .describe("可选文本搜索；只返回包含该文本的对象"),
    slide: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("可选的幻灯片页码，从 1 开始"),
  }),
  execute: async ({
    path,
    search,
    slide,
  }: {
    path: string;
    search?: string;
    slide?: number;
  }) => {
    const validation = await validateFile(path, [".pptx"]);
    if (!validation.valid) return { error: validation.error };
    try {
      const presentation = await inspectPptxPresentation(path);
      const normalizedSearch = search?.trim().toLocaleLowerCase();
      const slides = presentation.slides
        .filter((item) => slide === undefined || item.index === slide)
        .map((item) => ({
          ...item,
          objects: normalizedSearch
            ? item.objects.filter((object) =>
                object.textRuns.some((run) =>
                  run.text.toLocaleLowerCase().includes(normalizedSearch),
                ),
              )
            : item.objects,
        }))
        .filter(
          (item) =>
            !normalizedSearch ||
            item.objects.length > 0 ||
            item.notes.some((note) =>
              note.toLocaleLowerCase().includes(normalizedSearch),
            ),
        );
      return {
        slideCount: presentation.slideCount,
        slides,
      };
    } catch (error) {
      return {
        error: `PPTX 对象检查失败: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  },
};

const editPptxTextTool: Tool = {
  description:
    "按 inspectPptxObjects 返回的稳定 objectId 修改 PPTX 文本，并导出为新的可编辑 PPTX 文件",
  inputSchema: z.object({
    path: z.string().describe("源 PPTX 文件的绝对路径"),
    outputPath: z
      .string()
      .optional()
      .describe("输出 PPTX 的绝对路径；默认在源文件旁生成 *-edited.pptx"),
    edits: z
      .array(
        z.object({
          objectId: z
            .string()
            .describe("inspectPptxObjects 返回的文本 objectId"),
          text: z.string().describe("替换后的完整文本 run 内容"),
        }),
      )
      .min(1)
      .max(100),
  }),
  execute: async ({
    path,
    outputPath,
    edits,
  }: {
    path: string;
    outputPath?: string;
    edits: Array<{ objectId: string; text: string }>;
  }) => {
    const validation = await validateFile(path, [".pptx"]);
    if (!validation.valid) return { error: validation.error };
    try {
      return await editPptxPresentation({
        edits,
        outputPath,
        sourcePath: path,
      });
    } catch (error) {
      return {
        error: `PPTX 编辑失败: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  },
};

export const pptxEditor: Skill = {
  id: "pptx-editor",
  name: "PowerPoint 演示文稿编辑",
  description:
    "检查 PowerPoint 对象并对文本进行精确、可回写的本地编辑，保留原文件并导出副本",
  category: "task",
  keywords: [
    "编辑pptx",
    "修改pptx",
    "替换幻灯片文字",
    "编辑powerpoint",
    "edit pptx",
    "update presentation",
    "replace slide text",
  ],
  suggestions: [
    "把这个 PPTX 里的旧产品名替换为新产品名",
    "检查并修改第 3 页的标题",
  ],
  tools: {
    editPptxText: editPptxTextTool,
    inspectPptxObjects: inspectPptxObjectsTool,
  },
  systemPrompt: `You are executing a POWERPOINT EDITING task with a local structured PPTX model.

## Execution Steps
1. Always call \`inspectPptxObjects\` first and locate exact text object IDs.
2. Apply the smallest focused set of edits with \`editPptxText\`.
3. Export to a new .pptx copy. Never overwrite the source presentation.
4. Report the output path and edited slide numbers.

## Rules
- Never guess an object ID.
- Text object IDs are stable only for the inspected source revision.
- Preserve unrelated shapes, layouts, masters, media, notes, comments, transitions, and animations through round-trip export.
- If a requested object is not represented as editable text, explain that limitation instead of replacing the whole slide with an image.`,
};
