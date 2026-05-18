---
name: pptx
description: >
  创建、编辑、分析 PowerPoint 演示文稿。涵盖：从零创建、读取/解析 .pptx 内容、改造现有演示文稿、合并/拆分、处理模板和布局。当用户提到 PPT、幻灯片、演示文稿、deck、slides 或引用 .pptx 文件时触发。
context: fork
allowed-tools:
  - readFile
  - listDirectory
  - writeFile
  - createDirectory
  - runCommand
user-invocable: true
disable-model-invocation: false
requires:
  bins:
    - node
    - python3
  pip:
    - "markitdown[pptx,pdf]"
    - python-pptx
---

# PPTX 技能

用 PptxGenJS 生成 `.pptx`，方法论借鉴 zarazhangrui/frontend-slides：
分阶段工作流 + 视觉化风格发现 + 内容密度上限 + 反 AI-slop 设计原则。

## 核心原则

1. **PptxGenJS-first** — 输出真实可编辑的 `.pptx`（不是 HTML）。生成脚本统一放 `tmp/generate-slides.js`。
2. **Show, don't tell** — 风格选择阶段生成 3 张视觉预览给用户挑，不要让用户用文字描述偏好。
3. **Distinctive design** — 主动避开 AI slop 烂俗模式（默认蓝、Inter 字、紫粉渐变、标题下装饰线）。
4. **Content density limits** — 每页有上限，超过就拆页；不要堆叠、不要缩字。

---

## 设计美学 / 反 AI-slop 准则

你倾向生成"在分布上"的输出，在幻灯片里就是用户说的"AI slop"美学。**主动反方向走**：

**避免：**
- 默认蓝色（除非主题就要求）
- Inter / Roboto / Calibri 当所有页面唯一字体
- 紫粉渐变（白底紫粉是 AI 生成第二标志）
- 标题下装饰横线（AI 生成第一标志）
- 居中所有正文段落（标题可居中、正文左对齐）
- 纯文本页面（每页都要有视觉元素）
- 配色平均分布（必须 60-70% 主色 + 20-30% 辅色 + 5-10% 强调色）
- 同一页超过 3 种字体

**鼓励：**
- 字体可识别（衬线/无衬线/单空格/手写至少两种搭配）
- 强烈主色 + 锐利强调色 > 胆怯均匀调色板
- 每页一个明确焦点（数字/引言/图片/图表）
- 布局多样化（双栏、图标+文本、2x2 网格、半出血图）
- 主题驱动的配色（具体见 [STYLE_PRESETS.md](STYLE_PRESETS.md)）

---

## Content Density Limits

**每张幻灯片**的上限。超过 → 拆页。

| 幻灯片类型 | 上限                                                |
|------------|-----------------------------------------------------|
| 标题页     | 1 标题 + 1 副标题 + 可选 1 行 tagline               |
| 内容页     | 1 标题 + 4-6 项目符号 **或** 1 标题 + 2 段落        |
| 特性网格   | 1 标题 + 6 卡片（2x3 或 3x2）                       |
| 数据页     | 1 标题 + 1 大数字（60-72pt）+ 1 标签 **或** 1 图表  |
| 引言页     | 1 引语（≤ 3 行）+ 1 出处                            |
| 图片页     | 1 标题 + 1 图（高度 ≤ 60% 页面）                    |

超出限制？拆成多页。**不要堆叠、不要缩字、不要塞**。

---

## Phase 0: Mode 检测

判断用户意图：

- **Mode A: 全新生成** — 从零开始。进入 Phase 1。
- **Mode B: 改造现有 .pptx** — 用户提供了 `.pptx`。进入 Phase 4。
- **Mode C: 增量修改** — 已有 `tmp/generate-slides.js`，做局部调整。**应用下方修改规则。**

### Mode C: 修改规则

修改现有 deck 时，密度是最大风险：

1. **改动前** — 数清楚现页元素数量，对照密度表
2. **加图片** — 高度 `≤ 60%` 页面；如已满 → 拆成两页
3. **加文本** — 单页最多 4-6 项；超出 → 拆 continuation 页
4. **改完后必检** — 每个被改动的页跑一遍 QA（Phase 5）
5. **主动重组** — 改动会导致溢出时直接拆页并告知用户，不要等被纠错

---

## Phase 1: 内容发现（仅 Mode A）

**一次性 AskUserQuestion bundle 问完所有问题**（不要分多次问）：

| # | Question | Header | Options |
|---|----------|--------|---------|
| 1 | 这个演示文稿用途？ | Purpose | Pitch deck / 教学讲解 / 大会演讲 / 内部演示 |
| 2 | 大致需要多少张？ | Length | 短 5-10 / 中 10-20 / 长 20+ |
| 3 | 内容准备到什么程度？ | Content | 内容全就绪 / 粗略笔记 / 仅有主题 |
| 4 | 是否提供图片素材？ | Images | 有图（提供路径）/ 无图（用色块/形状装饰） |

### 图像评估子流程（当 Q4 选"有图"）

1. **扫描** — 列出文件夹下所有 `.png/.jpg/.svg/.webp`
2. **逐张读取** — 用 `readFile` 读图片（Claude 是多模态的）
3. **评估** — 给出：内容描述 / 可用还是不可用 / 代表的概念 / 主色调
4. **共同设计大纲** — 已筛图片驱动幻灯片结构（如 3 张产品截图 → 3 张特性页；1 个 logo → 标题/收尾页）。**不是先做大纲再塞图**
5. **确认** — AskUserQuestion `outline` 让用户确认大纲

---

## Phase 2: 风格发现（show, don't tell）

### Step 2.1 — 情绪选择

```
AskUserQuestion(header: "Vibe", multiSelect: true, max 2):
  观众应该有什么感觉？
  - Impressed / Confident      （专业、可信）
  - Excited / Energized        （创新、大胆）
  - Calm / Focused             （清晰、深思）
  - Inspired / Moved           （情感、记忆）
```

### Step 2.2 — 生成 3 张预览

根据 mood 从 [STYLE_PRESETS.md](STYLE_PRESETS.md) 中取 3 个匹配预设。Mood→预设映射：

| Mood        | Presets                                          |
|-------------|--------------------------------------------------|
| Impressed   | Bold Signal / Electric Studio / Charcoal Minimal |
| Excited     | Creative Voltage / Coral Vitality / Neon Cyber   |
| Calm        | Paper & Ink / Sage Tranquil / Swiss Modern       |
| Inspired    | Dark Botanical / Vintage Editorial / Berry Cream |

对每个预设生成 **1 张单页 .pptx** 然后转 PNG：

```bash
# 写 3 个单页 preview 脚本到 tmp/previews/
node tmp/previews/style-a.js   # → tmp/previews/style-a.pptx
node tmp/previews/style-b.js
node tmp/previews/style-c.js

# 批量转 PNG
mkdir -p tmp/previews/png
for s in a b c; do
  libreoffice --headless --convert-to pdf --outdir tmp/previews tmp/previews/style-$s.pptx
  pdftoppm -jpeg -r 120 tmp/previews/style-$s.pdf tmp/previews/png/style-$s
done

# 自动打开给用户看
open tmp/previews/png/style-a-1.jpg tmp/previews/png/style-b-1.jpg tmp/previews/png/style-c-1.jpg
```

每个预览页应展示：典型标题样式 + 一段正文 + 1-2 个装饰元素，体现该预设的"签名"（详见 STYLE_PRESETS.md 中 "Layout signature"）。

### Step 2.3 — 用户挑选

```
AskUserQuestion(header: "Style"):
  哪个预览最合适？
  - Style A: <preset 名>
  - Style B: <preset 名>
  - Style C: <preset 名>
  - 混合元素
```

如选"混合"，追问要从哪个预览拿哪些元素。

---

## Phase 3: 生成完整 deck

1. **读取选中的预设**（[STYLE_PRESETS.md](STYLE_PRESETS.md) 中对应章节）
2. **读取 [PPTXGEN_API.md](PPTXGEN_API.md)** — 代码片段都在那里
3. **写主脚本** `tmp/generate-slides.js`
4. **自动执行流程**（见下方）

### 自动执行流程（必须遵守）

你有 `runCommand`，**必须自动跑完整链路**，不要让用户手动执行任何命令。

标准流程：

1. `createDirectory` 创建 `tmp/`
2. `runCommand` 安装依赖：
   ```bash
   npm install --prefix tmp pptxgenjs
   # 如需图标
   npm install --prefix tmp react-icons react react-dom sharp
   ```
3. `writeFile` 写脚本到 `tmp/generate-slides.js`
4. `runCommand` 执行：`node tmp/generate-slides.js`
5. 如果报错 → 读 stderr → 修脚本 → 重写 → 重新执行（**最多重试 3 次**）
6. 成功后告知用户 `.pptx` 路径

错误处理：
- 模块未找到 → 重新安装依赖
- 语法错误 → 修脚本重写
- 达到重试上限 → 把错误信息和手动修复建议给用户

---

## Phase 4: 改造现有 .pptx（Mode B）

```bash
python3 .agents/skills/pptx/scripts/extract-pptx.py <input.pptx> tmp/extracted/
```

输出：
- `tmp/extracted/extracted-slides.json` — 标题/正文/图片/notes 结构化数据
- `tmp/extracted/assets/` — 原图资源

流程：
1. 跑 extract-pptx.py
2. 读 JSON，向用户展示标题清单 + 图片数 + notes 摘要
3. **AskUserQuestion** 确认改造范围（"保留哪些 / 重写哪些 / 整体重做"）
4. 进入 **Phase 2** 选风格
5. 进入 **Phase 3** 生成新 deck（在脚本里 `slide.addImage({ path: "tmp/extracted/assets/slideN_imgM.png" })` 引用原图）

---

## Phase 5: QA（强制，必须执行）

每次生成后都要 QA，第一次渲染几乎不会完美。

### 内容检查

```bash
python3 -m markitdown output.pptx
python3 -m markitdown output.pptx | grep -iE "xxxx|lorem|ipsum|placeholder|todo|示例|占位"
```

### 视觉检查

```bash
mkdir -p tmp/qa
libreoffice --headless --convert-to pdf --outdir tmp/qa output.pptx
pdftoppm -jpeg -r 150 tmp/qa/output.pdf tmp/qa/slide
```

逐张读 `tmp/qa/slide-*.jpg`（多模态），检查项：

- 元素重叠（文本穿形状、线穿文字）
- 文本溢出或被截断
- 间距 < 0.3"
- 边距 < 0.5"
- 低对比度文本或图标
- 残留占位符
- 是否触犯反 AI-slop 准则

### 验证循环

1. 生成 → 转图 → 巡查
2. 列问题
3. 修脚本
4. 重新生成受影响的页
5. 重新检查
6. 直到一轮无新问题

---

## Phase 6: 交付

1. 主产物 `.pptx` 路径告知用户
2. 把 QA 阶段生成的 `tmp/qa/output.pdf` 复制到 `.pptx` 同目录（用户常需要 PDF 版本）：
   ```bash
   cp tmp/qa/output.pdf $(dirname output.pptx)/$(basename output.pptx .pptx).pdf
   ```
3. 提示用户可清理：`rm -rf tmp/`

---

## tmp/ 目录规范

所有生成脚本、中间文件、QA 产物统一放 `tmp/`：

```
tmp/
├── generate-slides.js    # 主生成脚本
├── previews/             # Phase 2 风格预览
│   ├── style-{a,b,c}.js
│   ├── style-{a,b,c}.pptx
│   └── png/              # 转出来的预览图
├── extracted/            # Mode B 的抽取结果
│   ├── extracted-slides.json
│   └── assets/
├── unpacked/             # 解包的 .pptx XML（调试用）
├── qa/                   # PDF + 逐页 PNG
└── node_modules/         # 依赖（--prefix tmp）
```

规则：
- 脚本依赖装到 `tmp/`：`npm install --prefix tmp ...`
- 最终 `.pptx` 输出到工作区根目录（或用户指定位置），**不**放 tmp
- 完成后提示用户清理

---

## PptxGenJS 常见陷阱（精简版）

完整版见 [PPTXGEN_API.md](PPTXGEN_API.md)。生成前请读一遍：

1. 颜色不要加 `#` — `"FF0000"` ✅ / `"#FF0000"` ❌
2. 不要在颜色里编码透明度 — 用 `transparency` 或 `opacity`
3. 项目符号用 `bullet: true`，不要 unicode "•"
4. 数组多行用 `breakLine: true`
5. 项目符号配 `paraSpaceAfter`，慎用 `lineSpacing`
6. 每个 deck 新建 `pptxgen()` 实例
7. 不要复用 options 对象（PptxGenJS 原地修改），用工厂函数
8. ROUNDED_RECTANGLE 加边用 `line` 属性，不要覆矩形

---

## 支持文件

| 文件 | 用途 | 何时读取 |
|------|------|----------|
| [STYLE_PRESETS.md](STYLE_PRESETS.md) | 12 个视觉预设（配色/字体/布局签名） | Phase 2 + 3 |
| [PPTXGEN_API.md](PPTXGEN_API.md) | PptxGenJS API 代码片段 | Phase 3 |
| [scripts/extract-pptx.py](scripts/extract-pptx.py) | 抽取现有 .pptx → JSON + assets | Phase 4 |

---

## 当前工作区 PPTX 文件

!find . -name "*.pptx" -not -path "*/node_modules/*" -not -path "*/tmp/*" -maxdepth 3 2>/dev/null || echo "未找到 .pptx 文件"

