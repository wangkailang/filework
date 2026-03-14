# 实施计划：内置文件处理 Skills（PDF、XLSX、DOCX）

## 概述

基于需求和设计文档，将三个文件处理 Skills 的实现拆分为增量式编码任务。每个任务构建在前一个任务之上，从共享工具函数开始，逐步实现各 Skill，最后注册集成并编写测试。所有代码使用 TypeScript，工具函数使用 Zod v4 schema。

## 任务

- [x] 1. 安装第三方依赖并创建共享工具函数
  - [x] 1.1 安装 `pdf-parse`、`xlsx`、`mammoth` 和 `@types/pdf-parse` 依赖
    - 运行 `npm install pdf-parse xlsx mammoth` 和 `npm install -D @types/pdf-parse`
    - _需求: 2.1, 4.1, 6.1_

  - [x] 1.2 创建 `src/main/skills/file-skill-utils.ts` 共享文件校验模块
    - 实现 `validateFile` 函数：检查文件存在性、扩展名、50MB 大小限制
    - 导出 `FileValidationResult` 接口和 `MAX_FILE_SIZE` 常量
    - _需求: 2.4, 2.5, 4.4, 4.5, 6.4, 6.5_

  - [ ]* 1.3 编写 `src/main/skills/__tests__/file-skill-utils.test.ts` 单元测试
    - 测试文件不存在、扩展名不匹配、文件过大等场景
    - _需求: 2.4, 2.5, 4.4, 4.5, 6.4, 6.5_

- [x] 2. 实现 PDF Skill
  - [x] 2.1 创建 `src/main/skills/pdf-processor.ts`
    - 实现 `readPdfText` 工具函数：使用 `pdf-parse` 提取全文文本，返回 `{ text, pages }`
    - 实现 `readPdfPages` 工具函数：按页码范围提取文本，返回 `{ pages: Array<{ page, text }> }`
    - 实现 `getPdfMetadata` 工具函数：读取元数据，返回 `{ title, author, pages, createdAt }`
    - 所有工具函数调用 `validateFile` 前置校验，使用 Zod v4 定义 inputSchema
    - 定义 `pdfProcessor` Skill 对象：id 为 `"pdf-processor"`，包含中英文 keywords、systemPrompt、tools、suggestions
    - systemPrompt 引导 AI 先读取元数据、再按需提取文本/表格、最后结构化输出，支持 Markdown 格式转换
    - _需求: 1.1, 1.2, 1.3, 1.5, 2.1, 2.2, 2.3, 2.4, 2.5, 9.1_

  - [ ]* 2.2 编写 `src/main/skills/__tests__/pdf-processor.test.ts` 单元测试
    - 在 `src/main/skills/__tests__/fixtures/` 下准备 `sample.pdf` 测试文件
    - 测试 `readPdfText`、`readPdfPages`、`getPdfMetadata` 的正确返回值
    - 测试无效文件路径和非 PDF 文件的错误处理
    - _需求: 2.1, 2.2, 2.3, 2.4_

- [x] 3. 实现 XLSX Skill
  - [x] 3.1 创建 `src/main/skills/xlsx-processor.ts`
    - 实现 `listSheets` 工具函数：使用 `xlsx` 库读取工作表名称列表
    - 实现 `readSheet` 工具函数：读取指定工作表数据为 JSON 数组（表头为键），超过 1000 行截断并返回 `{ data, totalRows, truncated, truncatedMessage }`
    - 实现 `getSheetStats` 工具函数：返回 `{ rows, columns, columnNames }`
    - 所有工具函数调用 `validateFile` 前置校验，使用 Zod v4 定义 inputSchema
    - 定义 `xlsxProcessor` Skill 对象：id 为 `"xlsx-processor"`，包含中英文 keywords、systemPrompt、tools、suggestions
    - systemPrompt 引导 AI 先列出工作表、再按需读取数据、最后结构化输出，支持 CSV/JSON/Markdown 表格格式转换
    - _需求: 3.1, 3.2, 3.3, 3.5, 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 9.2_

  - [ ]* 3.2 编写 `src/main/skills/__tests__/xlsx-processor.test.ts` 单元测试
    - 在 `src/main/skills/__tests__/fixtures/` 下准备 `sample.xlsx` 测试文件（含多个工作表）
    - 测试 `listSheets`、`readSheet`、`getSheetStats` 的正确返回值
    - 测试 1000 行截断逻辑、无效文件路径和非 XLSX 文件的错误处理
    - _需求: 4.1, 4.2, 4.3, 4.4, 4.6_

- [x] 4. 实现 DOCX Skill
  - [x] 4.1 创建 `src/main/skills/docx-processor.ts`
    - 实现 `readDocxText` 工具函数：使用 `mammoth` 提取纯文本
    - 实现 `readDocxStructure` 工具函数：提取段落列表，每个段落包含 `{ text, style }`
    - 实现 `getDocxMetadata` 工具函数：返回 `{ title, author, createdAt, modifiedAt, paragraphs, words }`
    - 所有工具函数调用 `validateFile` 前置校验，使用 Zod v4 定义 inputSchema
    - 定义 `docxProcessor` Skill 对象：id 为 `"docx-processor"`，包含中英文 keywords、systemPrompt、tools、suggestions
    - systemPrompt 引导 AI 先读取文档结构、再按需提取全文或段落、最后结构化输出，支持 Markdown 格式转换（保留标题层级）
    - _需求: 5.1, 5.2, 5.3, 5.5, 6.1, 6.2, 6.3, 6.4, 6.5, 9.3_

  - [ ]* 4.2 编写 `src/main/skills/__tests__/docx-processor.test.ts` 单元测试
    - 在 `src/main/skills/__tests__/fixtures/` 下准备 `sample.docx` 测试文件（含标题层级和段落）
    - 测试 `readDocxText`、`readDocxStructure`、`getDocxMetadata` 的正确返回值
    - 测试无效文件路径和非 DOCX 文件的错误处理
    - _需求: 6.1, 6.2, 6.3, 6.4_

- [x] 5. 检查点 - 确保三个 Skill 实现完整
  - 确保所有测试通过，如有问题请向用户确认。

- [x] 6. 注册 Skills 并集成到现有系统
  - [x] 6.1 更新 `src/main/skills/index.ts`，导入并注册三个新 Skill
    - 导入 `pdfProcessor`、`xlsxProcessor`、`docxProcessor`
    - 将三个 Skill 添加到 `skills` 数组中
    - 确保 `getSkill`、`matchSkill`、`getAllSuggestions` 函数自动覆盖新 Skill
    - _需求: 1.4, 3.4, 5.4, 7.1, 7.2, 8.1, 8.4_

  - [ ]* 6.2 编写 `src/main/skills/__tests__/skills-registry.test.ts` 注册与匹配测试
    - 测试 `getSkill("pdf-processor")`、`getSkill("xlsx-processor")`、`getSkill("docx-processor")` 返回正确 Skill
    - 测试 `getAllSuggestions()` 包含新 Skill 的 suggestions
    - 测试 `matchSkill` 对格式特定提示词的匹配结果（如 "提取这个pdf的文本" 匹配 pdf-processor）
    - 测试新 Skill 关键词不与 data-processor 冲突
    - _需求: 1.4, 3.4, 5.4, 7.1, 7.2, 7.3, 8.1, 8.4_

- [ ] 7. 属性测试
  - [ ]* 7.1 编写属性测试：无效文件路径统一返回错误
    - **Property 1: 无效文件路径统一返回错误**
    - **验证: 需求 2.4, 4.4, 6.4**
    - 在 `src/main/skills/__tests__/file-skills.property.test.ts` 中使用 fast-check 生成随机不存在的文件路径
    - 对所有 9 个工具函数调用，验证均返回包含 `error` 字段的结果且不抛出异常

  - [ ]* 7.2 编写属性测试：格式特定关键词正确路由到对应 Skill
    - **Property 2: 格式特定关键词正确路由到对应 Skill**
    - **验证: 需求 7.1, 7.2**
    - 使用 fast-check 生成包含格式特定关键词的随机提示词
    - 验证 `matchSkill` 返回对应的文件处理 Skill 而非 data-processor

  - [ ]* 7.3 编写属性测试：systemPrompt 引用所有工具函数名称
    - **Property 3: systemPrompt 引用所有工具函数名称**
    - **验证: 需求 8.3**
    - 遍历三个新 Skill，验证每个 Skill 的 systemPrompt 包含其 tools 中的所有工具名称

  - [ ]* 7.4 编写属性测试：readSheet 超过 1000 行时截断
    - **Property 4: readSheet 超过 1000 行时截断**
    - **验证: 需求 4.6**
    - 使用 fast-check 生成超过 1000 行的随机数据，写入临时 XLSX 文件
    - 验证 `readSheet` 返回恰好 1000 行、`truncated` 为 true、`totalRows` 等于实际总行数

- [x] 8. 最终检查点 - 确保所有测试通过
  - 确保所有测试通过，如有问题请向用户确认。

## 备注

- 标记 `*` 的任务为可选任务，可跳过以加快 MVP 进度
- 每个任务引用了具体的需求编号，确保可追溯性
- 检查点任务确保增量验证
- 属性测试验证通用正确性属性，单元测试验证具体示例和边界情况
- 所有 Skill 的 systemPrompt 中需包含需求 9 中的格式转换指导（Markdown、CSV、JSON 等）
- 所有工具函数的 `execute` 方法内部捕获异常，统一返回 `{ error: string }` 格式
