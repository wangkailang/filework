# 需求文档：内置文件处理 Skills（PDF、XLSX、DOCX）

## 简介

为 FileWork 应用内置三种文件处理 Skills：PDF Skill、XLSX Skill 和 DOCX Skill。每个 Skill 遵循现有的 `Skill` 接口（`id`、`name`、`description`、`keywords`、`systemPrompt`、`tools`、`suggestions`），并参考 [Claude PDF Skill](https://github.com/anthropics/skills/blob/main/skills/pdf/SKILL.md) 的模式，为 AI 提供读取、解析、提取和转换这三种文件格式的能力。Skills 通过 `systemPrompt` 指导 AI 的处理策略，并通过 `tools` 字段提供格式专用的工具函数。

## 术语表

- **Skill**：FileWork 中的技能模块，实现 `Skill` 接口（定义于 `src/main/skills/types.ts`），包含 id、name、description、keywords、systemPrompt、tools、suggestions 字段
- **Skill_Registry**：`src/main/skills/index.ts` 中的 skills 数组，负责注册和匹配所有可用 Skill
- **Planner**：`src/main/planner/` 中的规划模块，根据用户提示词匹配 Skill 并生成执行计划
- **PDF_Skill**：处理 PDF 文件的 Skill，提供文本提取、页面解析、元数据读取等能力
- **XLSX_Skill**：处理 Excel（.xlsx/.xls）文件的 Skill，提供工作表读取、数据提取、格式转换等能力
- **DOCX_Skill**：处理 Word（.docx）文件的 Skill，提供文本提取、段落解析、结构分析等能力
- **Tool_Function**：Skill 中 `tools` 字段定义的工具函数，供 AI 在执行过程中调用以完成具体操作
- **Round_Trip**：解析后再序列化回原格式，验证数据完整性的往返测试

## 需求

### 需求 1：PDF Skill 定义与注册

**用户故事：** 作为用户，我想让 AI 能够理解和处理 PDF 文件，以便我可以通过自然语言提取 PDF 中的文本、表格和元数据信息。

#### 验收标准

1. THE PDF_Skill SHALL 实现 `Skill` 接口，包含 id 为 `"pdf-processor"`、name、description、keywords、systemPrompt 和 tools 字段
2. THE PDF_Skill SHALL 包含中英文关键词，覆盖 "pdf"、"PDF"、"文档"、"提取"、"extract"、"页面"、"page" 等常见用户意图词汇
3. THE PDF_Skill 的 systemPrompt SHALL 指导 AI 按以下策略处理 PDF 文件：先读取文件元数据，再按需提取文本或表格，最后以结构化格式输出结果
4. WHEN PDF_Skill 被定义后，THE Skill_Registry SHALL 将 PDF_Skill 注册到 skills 数组中，使其可被 Planner 匹配和调用
5. THE PDF_Skill SHALL 提供至少两条 suggestions，引导用户了解 PDF 处理能力

### 需求 2：PDF Skill 工具函数

**用户故事：** 作为用户，我想让 AI 能够调用专用工具来读取 PDF 文件内容，以便获得准确的文本提取和结构化数据。

#### 验收标准

1. THE PDF_Skill SHALL 通过 tools 字段提供 `readPdfText` 工具函数，接受文件路径参数，返回 PDF 全文文本内容
2. THE PDF_Skill SHALL 通过 tools 字段提供 `readPdfPages` 工具函数，接受文件路径和可选的页码范围参数，返回指定页面的文本内容
3. THE PDF_Skill SHALL 通过 tools 字段提供 `getPdfMetadata` 工具函数，接受文件路径参数，返回 PDF 的元数据信息（标题、作者、页数、创建日期）
4. IF 指定的文件路径不存在或文件不是有效的 PDF 格式，THEN THE PDF_Skill 的工具函数 SHALL 返回包含明确错误描述的错误信息
5. IF PDF 文件大小超过 50MB，THEN THE PDF_Skill 的工具函数 SHALL 返回文件过大的警告信息并拒绝处理

### 需求 3：XLSX Skill 定义与注册

**用户故事：** 作为用户，我想让 AI 能够理解和处理 Excel 文件，以便我可以通过自然语言查询、分析和转换表格数据。

#### 验收标准

1. THE XLSX_Skill SHALL 实现 `Skill` 接口，包含 id 为 `"xlsx-processor"`、name、description、keywords、systemPrompt 和 tools 字段
2. THE XLSX_Skill SHALL 包含中英文关键词，覆盖 "excel"、"xlsx"、"xls"、"表格"、"spreadsheet"、"工作表"、"sheet" 等常见用户意图词汇
3. THE XLSX_Skill 的 systemPrompt SHALL 指导 AI 按以下策略处理 XLSX 文件：先列出工作表名称，再按需读取指定工作表数据，最后以结构化格式输出结果
4. WHEN XLSX_Skill 被定义后，THE Skill_Registry SHALL 将 XLSX_Skill 注册到 skills 数组中，使其可被 Planner 匹配和调用
5. THE XLSX_Skill SHALL 提供至少两条 suggestions，引导用户了解 Excel 处理能力

### 需求 4：XLSX Skill 工具函数

**用户故事：** 作为用户，我想让 AI 能够调用专用工具来读取 Excel 文件内容，以便获得准确的表格数据和结构信息。

#### 验收标准

1. THE XLSX_Skill SHALL 通过 tools 字段提供 `listSheets` 工具函数，接受文件路径参数，返回所有工作表名称列表
2. THE XLSX_Skill SHALL 通过 tools 字段提供 `readSheet` 工具函数，接受文件路径和可选的工作表名称参数，返回指定工作表的数据（默认返回第一个工作表），数据格式为 JSON 数组（每行一个对象，以表头为键）
3. THE XLSX_Skill SHALL 通过 tools 字段提供 `getSheetStats` 工具函数，接受文件路径和可选的工作表名称参数，返回工作表的统计信息（行数、列数、列名列表）
4. IF 指定的文件路径不存在或文件不是有效的 XLSX/XLS 格式，THEN THE XLSX_Skill 的工具函数 SHALL 返回包含明确错误描述的错误信息
5. IF XLSX 文件大小超过 50MB，THEN THE XLSX_Skill 的工具函数 SHALL 返回文件过大的警告信息并拒绝处理
6. WHEN readSheet 工具函数读取的工作表行数超过 1000 行时，THE XLSX_Skill SHALL 仅返回前 1000 行数据，并在返回结果中注明总行数和截断信息

### 需求 5：DOCX Skill 定义与注册

**用户故事：** 作为用户，我想让 AI 能够理解和处理 Word 文档，以便我可以通过自然语言提取文档内容、分析结构和获取关键信息。

#### 验收标准

1. THE DOCX_Skill SHALL 实现 `Skill` 接口，包含 id 为 `"docx-processor"`、name、description、keywords、systemPrompt 和 tools 字段
2. THE DOCX_Skill SHALL 包含中英文关键词，覆盖 "word"、"docx"、"doc"、"文档"、"document"、"段落"、"paragraph" 等常见用户意图词汇
3. THE DOCX_Skill 的 systemPrompt SHALL 指导 AI 按以下策略处理 DOCX 文件：先读取文档结构（标题层级），再按需提取全文或指定段落，最后以结构化格式输出结果
4. WHEN DOCX_Skill 被定义后，THE Skill_Registry SHALL 将 DOCX_Skill 注册到 skills 数组中，使其可被 Planner 匹配和调用
5. THE DOCX_Skill SHALL 提供至少两条 suggestions，引导用户了解 Word 文档处理能力

### 需求 6：DOCX Skill 工具函数

**用户故事：** 作为用户，我想让 AI 能够调用专用工具来读取 Word 文档内容，以便获得准确的文本和结构化信息。

#### 验收标准

1. THE DOCX_Skill SHALL 通过 tools 字段提供 `readDocxText` 工具函数，接受文件路径参数，返回文档的纯文本内容
2. THE DOCX_Skill SHALL 通过 tools 字段提供 `readDocxStructure` 工具函数，接受文件路径参数，返回文档的结构信息（标题层级、段落列表，每个段落包含文本内容和样式类型）
3. THE DOCX_Skill SHALL 通过 tools 字段提供 `getDocxMetadata` 工具函数，接受文件路径参数，返回文档的元数据信息（标题、作者、创建日期、修改日期、段落数、字数）
4. IF 指定的文件路径不存在或文件不是有效的 DOCX 格式，THEN THE DOCX_Skill 的工具函数 SHALL 返回包含明确错误描述的错误信息
5. IF DOCX 文件大小超过 50MB，THEN THE DOCX_Skill 的工具函数 SHALL 返回文件过大的警告信息并拒绝处理

### 需求 7：Skill 关键词冲突处理

**用户故事：** 作为用户，我希望当我的提示词涉及多种文件格式时，系统能准确匹配到最相关的 Skill。

#### 验收标准

1. THE Skill_Registry 的 matchSkill 函数 SHALL 在新增三个 Skill 后仍能正确匹配：当用户提示词明确包含 "pdf" 时匹配 PDF_Skill，包含 "excel" 或 "xlsx" 时匹配 XLSX_Skill，包含 "word" 或 "docx" 时匹配 DOCX_Skill
2. THE PDF_Skill、XLSX_Skill 和 DOCX_Skill 的 keywords SHALL 避免与现有 data-processor Skill 的关键词产生高权重冲突，确保文件格式特定的关键词（如 "pdf"、"xlsx"、"docx"）优先匹配到对应的文件处理 Skill
3. WHEN 用户提示词同时包含多种文件格式关键词时，THE Skill_Registry SHALL 通过现有的评分机制（关键词长度 + 多关键词命中奖励）选择匹配度最高的 Skill

### 需求 8：Skill 与现有系统集成

**用户故事：** 作为用户，我希望新增的文件处理 Skills 能与 FileWork 现有的 Planner 和执行系统无缝集成。

#### 验收标准

1. WHEN 用户在聊天中发送包含文件处理意图的提示词时，THE Planner SHALL 能够在生成的执行计划中正确引用新增 Skill 的 id（"pdf-processor"、"xlsx-processor"、"docx-processor"）
2. THE PDF_Skill、XLSX_Skill 和 DOCX_Skill 的 tools 字段中定义的工具函数 SHALL 符合 Vercel AI SDK 的 `Tool` 类型定义，确保 AI 模型能正确调用
3. THE PDF_Skill、XLSX_Skill 和 DOCX_Skill 的 systemPrompt SHALL 引导 AI 使用对应 Skill 的 tools 中定义的工具函数名称，确保 systemPrompt 与 tools 定义一致
4. THE 三个新增 Skill 的 suggestions SHALL 出现在 `getAllSuggestions` 函数的返回结果中，供前端引导界面展示

### 需求 9：文件格式转换输出

**用户故事：** 作为用户，我想让 AI 能够将提取的文件内容转换为其他格式输出，以便我可以方便地使用这些数据。

#### 验收标准

1. THE PDF_Skill 的 systemPrompt SHALL 指导 AI 支持将 PDF 文本内容输出为 Markdown 格式
2. THE XLSX_Skill 的 systemPrompt SHALL 指导 AI 支持将工作表数据输出为 CSV、JSON 或 Markdown 表格格式
3. THE DOCX_Skill 的 systemPrompt SHALL 指导 AI 支持将文档内容输出为 Markdown 格式，保留标题层级结构
4. WHEN AI 将文件内容转换为其他格式并输出到文件时，THE Skill 的 systemPrompt SHALL 指导 AI 使用 `writeFile` 工具将结果保存到工作区，文件名遵循 `[原文件名]_converted.[目标扩展名]` 的命名规则
