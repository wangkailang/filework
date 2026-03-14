---
name: pptx
description: >
  创建、编辑、分析 PowerPoint 演示文稿。涵盖：从零创建幻灯片、读取/解析 .pptx 文件内容、修改现有演示文稿、合并/拆分幻灯片、处理模板和布局。当用户提到 PPT、幻灯片、演示文稿、deck、slides 或引用 .pptx 文件时触发此技能。
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
---

# PPTX 技能

## 临时目录规范

所有生成脚本、中间文件、QA 产物统一放到 `tmp/` 目录下，保持工作区整洁。

```
tmp/
├── generate-slides.js    # PptxGenJS 生成脚本
├── icons/                # 图标渲染中间 PNG
├── unpacked/             # 解包的 .pptx XML（用于编辑）
├── qa/                   # QA 检查产物（PDF、截图）
│   ├── output.pdf
│   └── slide-*.jpg
└── node_modules/         # 脚本依赖（npm install --prefix tmp）
```

规则：
- 生成脚本写入 `tmp/generate-slides.js`，在 `tmp/` 下执行 `node generate-slides.js`
- 解包 XML 到 `tmp/unpacked/`
- QA 转换的 PDF/图片放到 `tmp/qa/`
- 脚本依赖安装到 `tmp/`：`npm install --prefix tmp pptxgenjs`
- 最终 .pptx 输出到用户指定位置（默认工作区根目录），不放 tmp
- 完成后可提示用户清理：`rm -rf tmp/`

## 自动执行流程（必须遵守）

你拥有 `runCommand` 工具，可以直接执行 shell 命令。生成 PPT 时必须自动完成全部流程，不要让用户手动执行任何命令。

标准流程：
1. 用 `createDirectory` 创建 `tmp/` 目录
2. 用 `runCommand` 安装依赖：`npm install --prefix tmp pptxgenjs`（如需图标再加 `react-icons react react-dom sharp`）
3. 用 `writeFile` 写入生成脚本到 `tmp/generate-slides.js`
4. 用 `runCommand` 执行脚本：`node tmp/generate-slides.js`
5. 如果执行报错，读取错误信息，修复脚本，重新写入并执行（最多重试 3 次）
6. 执行成功后，告知用户 .pptx 文件的位置

错误处理：
- 如果 `runCommand` 返回非零 exitCode，分析 stderr 中的错误信息
- 常见错误：模块未找到 → 重新安装依赖；语法错误 → 修复脚本重写
- 每次修复后重新执行，直到成功或达到重试上限
- 达到重试上限后，向用户展示错误信息并给出手动修复建议

## 快速参考

| 任务 | 方法 |
|------|------|
| 读取/分析内容 | `python3 -m markitdown presentation.pptx` |
| 从零创建 | 使用 PptxGenJS（见下方教程） |
| 编辑现有文件 | 解包 → 修改 XML → 重新打包 |

## 当前工作区 PPTX 文件

!find . -name "*.pptx" -not -path "*/node_modules/*" -not -path "*/tmp/*" -maxdepth 3 2>/dev/null || echo "未找到 .pptx 文件"

---

## 读取内容

```bash
# 文本提取
python3 -m markitdown presentation.pptx

# 查看原始 XML（解包到 tmp）
mkdir -p tmp/unpacked
unzip -o presentation.pptx -d tmp/unpacked/
```

---

## 从零创建（PptxGenJS）

当没有模板或参考演示文稿时使用此方法。

### 基本结构

生成脚本统一写入 `tmp/generate-slides.js`，依赖安装到 `tmp/`。

```bash
# 初始化 tmp 目录并安装依赖
mkdir -p tmp
npm install --prefix tmp pptxgenjs
```

```javascript
// tmp/generate-slides.js
const pptxgen = require("./node_modules/pptxgenjs");
const path = require("path");

let pres = new pptxgen();
pres.layout = 'LAYOUT_16x9';  // 10" × 5.625"
pres.author = 'FileWork';
pres.title = '演示文稿标题';

let slide = pres.addSlide();
slide.addText("Hello World!", { x: 0.5, y: 0.5, fontSize: 36, color: "363636" });

// 输出到工作区根目录，不放 tmp
pres.writeFile({ fileName: path.resolve(__dirname, "..", "output.pptx") });
```

```bash
# 在 tmp 目录下执行脚本
node tmp/generate-slides.js
```

### 布局尺寸（坐标单位：英寸）

- `LAYOUT_16x9`: 10" × 5.625"（默认）
- `LAYOUT_16x10`: 10" × 6.25"
- `LAYOUT_4x3`: 10" × 7.5"
- `LAYOUT_WIDE`: 13.3" × 7.5"

### 文本与格式

```javascript
// 基本文本
slide.addText("标题", {
  x: 1, y: 1, w: 8, h: 2, fontSize: 24, fontFace: "Arial",
  color: "363636", bold: true, align: "center", valign: "middle"
});

// 富文本数组
slide.addText([
  { text: "粗体 ", options: { bold: true } },
  { text: "斜体 ", options: { italic: true } }
], { x: 1, y: 3, w: 8, h: 1 });

// 多行文本（需要 breakLine: true）
slide.addText([
  { text: "第一行", options: { breakLine: true } },
  { text: "第二行", options: { breakLine: true } },
  { text: "第三行" }
], { x: 0.5, y: 0.5, w: 8, h: 2 });
```

### 列表与项目符号

```javascript
// ✅ 正确：多个项目符号
slide.addText([
  { text: "第一项", options: { bullet: true, breakLine: true } },
  { text: "第二项", options: { bullet: true, breakLine: true } },
  { text: "第三项", options: { bullet: true } }
], { x: 0.5, y: 0.5, w: 8, h: 3 });

// ❌ 错误：不要使用 unicode 符号
slide.addText("• 第一项", { ... });  // 会产生双重项目符号
```

### 形状

```javascript
slide.addShape(pres.shapes.RECTANGLE, {
  x: 0.5, y: 0.8, w: 1.5, h: 3.0,
  fill: { color: "FF0000" }, line: { color: "000000", width: 2 }
});

// 带阴影
slide.addShape(pres.shapes.RECTANGLE, {
  x: 1, y: 1, w: 3, h: 2,
  fill: { color: "FFFFFF" },
  shadow: { type: "outer", color: "000000", blur: 6, offset: 2, angle: 135, opacity: 0.15 }
});
```

### 图片

```javascript
// 从文件路径
slide.addImage({ path: "images/chart.png", x: 1, y: 1, w: 5, h: 3 });

// 从 base64
slide.addImage({ data: "image/png;base64,iVBORw0KGgo...", x: 1, y: 1, w: 5, h: 3 });

// 保持宽高比
const origW = 1978, origH = 923, maxH = 3.0;
const calcW = maxH * (origW / origH);
const centerX = (10 - calcW) / 2;
slide.addImage({ path: "image.png", x: centerX, y: 1.2, w: calcW, h: maxH });
```

### 图标（react-icons + sharp）

```bash
# 安装图标依赖到 tmp
npm install --prefix tmp react-icons react react-dom sharp
```

```javascript
// tmp/generate-slides.js 中使用
const React = require("./node_modules/react");
const ReactDOMServer = require("./node_modules/react-dom/server");
const sharp = require("./node_modules/sharp");
const { FaCheckCircle } = require("./node_modules/react-icons/fa");

function renderIconSvg(Icon, color = "#000000", size = 256) {
  return ReactDOMServer.renderToStaticMarkup(
    React.createElement(Icon, { color, size: String(size) })
  );
}

async function iconToBase64Png(Icon, color, size = 256) {
  const svg = renderIconSvg(Icon, color, size);
  const buf = await sharp(Buffer.from(svg)).png().toBuffer();
  return "image/png;base64," + buf.toString("base64");
}

const iconData = await iconToBase64Png(FaCheckCircle, "#4472C4", 256);
slide.addImage({ data: iconData, x: 1, y: 1, w: 0.5, h: 0.5 });
```

### 背景

```javascript
slide.background = { color: "F1F1F1" };                    // 纯色
slide.background = { path: "https://example.com/bg.jpg" }; // 图片
```

### 表格

```javascript
slide.addTable([
  [{ text: "表头1", options: { fill: { color: "6699CC" }, color: "FFFFFF", bold: true } }, "表头2"],
  ["单元格1", "单元格2"]
], { x: 1, y: 1, w: 8, h: 2, border: { pt: 1, color: "999999" } });
```

### 图表

```javascript
// 柱状图
slide.addChart(pres.charts.BAR, [{
  name: "销售额", labels: ["Q1", "Q2", "Q3", "Q4"], values: [4500, 5500, 6200, 7100]
}], {
  x: 0.5, y: 0.6, w: 6, h: 3, barDir: 'col',
  showTitle: true, title: '季度销售',
  chartColors: ["0D9488", "14B8A6", "5EEAD4"],
  valGridLine: { color: "E2E8F0", size: 0.5 },
  catGridLine: { style: "none" },
  showValue: true, dataLabelPosition: "outEnd"
});

// 饼图
slide.addChart(pres.charts.PIE, [{
  name: "份额", labels: ["A", "B", "其他"], values: [35, 45, 20]
}], { x: 7, y: 1, w: 5, h: 4, showPercent: true });
```

---

## 设计指南

### 配色方案

根据主题选择配色，不要默认蓝色：

| 主题 | 主色 | 辅色 | 强调色 |
|------|------|------|--------|
| 午夜商务 | `1E2761` | `CADCFC` | `FFFFFF` |
| 森林苔藓 | `2C5F2D` | `97BC62` | `F5F5F5` |
| 珊瑚活力 | `F96167` | `F9E795` | `2F3C7E` |
| 暖赭石 | `B85042` | `E7E8D1` | `A7BEAE` |
| 海洋渐变 | `065A82` | `1C7293` | `21295C` |
| 炭灰极简 | `36454F` | `F2F2F2` | `212121` |
| 青绿信任 | `028090` | `00A896` | `02C39A` |
| 浆果奶油 | `6D2E46` | `A26769` | `ECE2D0` |
| 鼠尾草 | `84B59F` | `69A297` | `50808E` |
| 樱桃大胆 | `990011` | `FCF6F5` | `2F3C7E` |

### 字体搭配

| 标题字体 | 正文字体 |
|----------|----------|
| Georgia | Calibri |
| Arial Black | Arial |
| Trebuchet MS | Calibri |
| Palatino | Garamond |

| 元素 | 字号 |
|------|------|
| 幻灯片标题 | 36-44pt 粗体 |
| 章节标题 | 20-24pt 粗体 |
| 正文 | 14-16pt |
| 注释 | 10-12pt |

### 布局原则

- 每张幻灯片都需要视觉元素（图片、图表、图标或形状），避免纯文本
- 布局多样化：双栏、图标+文本行、2x2 网格、半出血图片
- 数据展示：大号数字（60-72pt）+ 小标签、对比列、时间线
- 间距：最小 0.5" 边距，内容块间 0.3-0.5"
- 60-70% 主色 + 辅色 + 一个强调色，不要平均分配

### 避免的常见错误

- 不要重复相同布局 — 在列、卡片和标注之间变化
- 不要居中正文 — 左对齐段落和列表，仅居中标题
- 不要默认蓝色 — 选择反映具体主题的颜色
- 不要创建纯文本幻灯片 — 添加图片、图标、图表
- 不要在标题下使用装饰线 — 这是 AI 生成幻灯片的标志

---

## 常见陷阱（必读）

1. **颜色不要加 "#"** — `color: "FF0000"` ✅ / `color: "#FF0000"` ❌（会损坏文件）
2. **不要在颜色字符串中编码透明度** — 8 位颜色如 `"00000020"` 会损坏文件，用 `opacity` 属性
3. **用 `bullet: true`** — 不要用 unicode "•"（会产生双重符号）
4. **用 `breakLine: true`** — 数组项之间需要换行
5. **避免 `lineSpacing` 配合项目符号** — 用 `paraSpaceAfter` 代替
6. **每个演示文稿用新实例** — 不要复用 `pptxgen()` 对象
7. **不要复用选项对象** — PptxGenJS 会原地修改对象，用工厂函数创建：
   ```javascript
   const makeShadow = () => ({ type: "outer", blur: 6, offset: 2, color: "000000", opacity: 0.15 });
   slide.addShape(pres.shapes.RECTANGLE, { shadow: makeShadow(), ... }); // ✅
   ```
8. **不要对 ROUNDED_RECTANGLE 使用装饰边框** — 矩形覆盖层无法覆盖圆角

---

## QA 检查（必须执行）

每次生成后都要检查，第一次渲染几乎不会完美。

### 内容检查

```bash
python3 -m markitdown output.pptx
# 检查模板残留文本
python3 -m markitdown output.pptx | grep -iE "xxxx|lorem|ipsum|placeholder"
```

### 视觉检查

转换为图片后逐张检查（产物放 tmp/qa）：

```bash
mkdir -p tmp/qa
libreoffice --headless --convert-to pdf --outdir tmp/qa output.pptx
pdftoppm -jpeg -r 150 tmp/qa/output.pdf tmp/qa/slide
```

检查项：
- 元素重叠（文本穿过形状、线条穿过文字）
- 文本溢出或被截断
- 元素间距不均（< 0.3" 间隙）
- 边距不足（< 0.5"）
- 低对比度文本或图标
- 残留占位符内容

### 验证循环

1. 生成 → 转图片 → 检查
2. 列出发现的问题
3. 修复问题
4. 重新验证受影响的幻灯片
5. 重复直到一轮完整检查无新问题

---

## 依赖安装

```bash
pip install "markitdown[pptx]"   # 文本提取
pip install Pillow               # 缩略图

# 项目级依赖安装到 tmp（不污染全局和工作区）
mkdir -p tmp
npm install --prefix tmp pptxgenjs
# 图标支持（可选）
npm install --prefix tmp react-icons react react-dom sharp
```
