# PptxGenJS API 速查

完整 API 速查与代码片段。SKILL.md 的 Phase 3 生成阶段应读取本文件。

---

## 基本结构

生成脚本统一写入 `tmp/generate-slides.js`，依赖装到 `tmp/`：

```bash
mkdir -p tmp
npm install --prefix tmp pptxgenjs
```

```javascript
// tmp/generate-slides.js
const pptxgen = require("./node_modules/pptxgenjs");
const path = require("path");

let pres = new pptxgen();
pres.layout = "LAYOUT_16x9";   // 10" × 5.625"
pres.author = "FileWork";
pres.title = "演示文稿标题";

let slide = pres.addSlide();
slide.addText("Hello World!", { x: 0.5, y: 0.5, fontSize: 36, color: "363636" });

// 输出到工作区根目录，不放 tmp
pres.writeFile({ fileName: path.resolve(__dirname, "..", "output.pptx") });
```

```bash
node tmp/generate-slides.js
```

---

## 布局尺寸（坐标单位：英寸）

| 布局 | 尺寸 |
|------|------|
| `LAYOUT_16x9`（默认） | 10" × 5.625" |
| `LAYOUT_16x10` | 10" × 6.25" |
| `LAYOUT_4x3` | 10" × 7.5" |
| `LAYOUT_WIDE` | 13.3" × 7.5" |

自定义：`pres.defineLayout({ name: "CUSTOM", width: 13.3, height: 7.5 })`。

---

## 文本

### 基础

```javascript
slide.addText("标题", {
  x: 1, y: 1, w: 8, h: 2,
  fontSize: 24, fontFace: "Inter",
  color: "363636", bold: true,
  align: "center", valign: "middle"
});
```

### 富文本（数组）

```javascript
slide.addText([
  { text: "粗体 ", options: { bold: true } },
  { text: "斜体 ", options: { italic: true } },
  { text: "彩色", options: { color: "FF0000" } }
], { x: 1, y: 3, w: 8, h: 1 });
```

### 多行（数组 + breakLine）

```javascript
slide.addText([
  { text: "第一行", options: { breakLine: true } },
  { text: "第二行", options: { breakLine: true } },
  { text: "第三行" }
], { x: 0.5, y: 0.5, w: 8, h: 2 });
```

### 项目符号

```javascript
// ✅ 正确
slide.addText([
  { text: "第一项", options: { bullet: true, breakLine: true } },
  { text: "第二项", options: { bullet: true, breakLine: true } },
  { text: "第三项", options: { bullet: true } }
], { x: 0.5, y: 0.5, w: 8, h: 3 });

// ❌ 错误：unicode 符号会产生双重项目符号
slide.addText("• 第一项", { });
```

数字编号：`bullet: { type: "number" }`。

---

## 形状

```javascript
slide.addShape(pres.shapes.RECTANGLE, {
  x: 0.5, y: 0.8, w: 1.5, h: 3.0,
  fill: { color: "FF0000" },
  line: { color: "000000", width: 2 }
});

// 带阴影（用工厂函数，详见陷阱 #7）
const makeShadow = () => ({
  type: "outer", color: "000000",
  blur: 6, offset: 2, angle: 135, opacity: 0.15
});

slide.addShape(pres.shapes.RECTANGLE, {
  x: 1, y: 1, w: 3, h: 2,
  fill: { color: "FFFFFF" },
  shadow: makeShadow()
});
```

常用形状：`RECTANGLE`、`ROUNDED_RECTANGLE`、`OVAL`、`LINE`、`CHEVRON`、`RIGHT_TRIANGLE`、`PARALLELOGRAM`。

---

## 图片

```javascript
// 文件路径
slide.addImage({ path: "images/chart.png", x: 1, y: 1, w: 5, h: 3 });

// base64
slide.addImage({
  data: "image/png;base64,iVBORw0KGgo...",
  x: 1, y: 1, w: 5, h: 3
});

// 等比缩放（核心：先算出 calcW，再居中）
const origW = 1978, origH = 923, maxH = 3.0;
const calcW = maxH * (origW / origH);
const centerX = (10 - calcW) / 2;
slide.addImage({ path: "image.png", x: centerX, y: 1.2, w: calcW, h: maxH });

// 圆角裁剪
slide.addImage({
  path: "photo.jpg", x: 1, y: 1, w: 4, h: 3,
  rounding: true
});
```

---

## 图标（react-icons + sharp）

```bash
npm install --prefix tmp react-icons react react-dom sharp
```

```javascript
const React = require("./node_modules/react");
const ReactDOMServer = require("./node_modules/react-dom/server");
const sharp = require("./node_modules/sharp");
const { FaCheckCircle, FaRocket } = require("./node_modules/react-icons/fa");

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

// 在 async main 中使用
const iconData = await iconToBase64Png(FaCheckCircle, "#4472C4", 256);
slide.addImage({ data: iconData, x: 1, y: 1, w: 0.5, h: 0.5 });
```

图标来源：`react-icons/fa`（FontAwesome）、`/md`（Material）、`/hi`（Heroicons）、`/lu`（Lucide）。

---

## 背景

```javascript
slide.background = { color: "F1F1F1" };                      // 纯色
slide.background = { path: "bg.jpg" };                       // 本地图片
slide.background = { path: "https://example.com/bg.jpg" };   // 远程图片
slide.background = { data: "image/png;base64,..." };         // base64
```

---

## 表格

```javascript
slide.addTable([
  [
    { text: "表头1", options: { fill: { color: "6699CC" }, color: "FFFFFF", bold: true } },
    { text: "表头2", options: { fill: { color: "6699CC" }, color: "FFFFFF", bold: true } }
  ],
  ["单元格1", "单元格2"],
  ["单元格3", "单元格4"]
], {
  x: 1, y: 1, w: 8, h: 2,
  border: { pt: 1, color: "999999" },
  fontSize: 12,
  rowH: 0.5
});
```

合并：`colspan` / `rowspan` 在单元格 options 中设置。

---

## 图表

### 柱状图

```javascript
slide.addChart(pres.charts.BAR, [{
  name: "销售额",
  labels: ["Q1", "Q2", "Q3", "Q4"],
  values: [4500, 5500, 6200, 7100]
}], {
  x: 0.5, y: 0.6, w: 6, h: 3, barDir: "col",
  showTitle: true, title: "季度销售",
  chartColors: ["0D9488", "14B8A6", "5EEAD4"],
  valGridLine: { color: "E2E8F0", size: 0.5 },
  catGridLine: { style: "none" },
  showValue: true, dataLabelPosition: "outEnd"
});
```

### 饼图

```javascript
slide.addChart(pres.charts.PIE, [{
  name: "份额", labels: ["A", "B", "其他"], values: [35, 45, 20]
}], {
  x: 7, y: 1, w: 5, h: 4,
  showPercent: true,
  chartColors: ["F96167", "F9E795", "2F3C7E"]
});
```

### 折线图

```javascript
slide.addChart(pres.charts.LINE, [
  { name: "去年", labels: ["1月","2月","3月","4月"], values: [10, 20, 15, 30] },
  { name: "今年", labels: ["1月","2月","3月","4月"], values: [15, 25, 25, 40] }
], {
  x: 1, y: 1, w: 8, h: 4,
  chartColors: ["1E2761", "F96167"],
  lineSize: 3, lineDataSymbol: "circle"
});
```

可用图表：`BAR`、`PIE`、`DOUGHNUT`、`LINE`、`AREA`、`SCATTER`、`RADAR`、`BUBBLE`。

---

## 常见陷阱（完整版 — 必读）

### 1. 颜色不要加 `#`

```javascript
// ✅ 正确
{ color: "FF0000" }

// ❌ 会损坏文件
{ color: "#FF0000" }
```

### 2. 不要在颜色字符串中编码透明度

8 位颜色（如 `"00000020"`）会损坏文件。透明度用 `transparency` 或 `opacity`：

```javascript
// ✅
{ fill: { color: "000000", transparency: 80 } }   // transparency: 0–100

// ❌
{ fill: { color: "00000020" } }
```

### 3. 项目符号用 `bullet: true`，不要用 unicode "•"

unicode 符号会产生双重项目符号。详见上文"文本/项目符号"。

### 4. 数组项之间需要 `breakLine: true`

不写 `breakLine` 时数组会拼成一行。

### 5. 避免 `lineSpacing` 配合项目符号

会出现间距异常。用 `paraSpaceAfter` 代替：

```javascript
// ✅
{ paraSpaceAfter: 6, bullet: true }

// ⚠ 慎用
{ lineSpacing: 24, bullet: true }
```

### 6. 每个演示文稿用新 `pptxgen()` 实例

不要复用：

```javascript
// ❌
const pres = new pptxgen();
function makeDeck() { /* 复用 pres */ }
makeDeck(); makeDeck();   // 第二次会污染第一次

// ✅
function makeDeck() {
  const pres = new pptxgen();
  /* ... */
}
```

### 7. 不要复用 options 对象

PptxGenJS 会**原地修改**传入的对象。用工厂函数：

```javascript
// ❌ 第二次会带上第一次的内部状态
const shadowOpts = { type: "outer", blur: 6, offset: 2, color: "000000", opacity: 0.15 };
slide.addShape(pres.shapes.RECTANGLE, { shadow: shadowOpts });
slide.addShape(pres.shapes.OVAL, { shadow: shadowOpts });

// ✅
const makeShadow = () => ({ type: "outer", blur: 6, offset: 2, color: "000000", opacity: 0.15 });
slide.addShape(pres.shapes.RECTANGLE, { shadow: makeShadow() });
slide.addShape(pres.shapes.OVAL, { shadow: makeShadow() });
```

### 8. 不要对 ROUNDED_RECTANGLE 加装饰边框矩形

矩形覆盖层无法覆盖圆角；改用 `line` 属性给 ROUNDED_RECTANGLE 本身加边：

```javascript
slide.addShape(pres.shapes.ROUNDED_RECTANGLE, {
  x: 1, y: 1, w: 3, h: 2,
  fill: { color: "FFFFFF" },
  line: { color: "1E2761", width: 2 },
  rectRadius: 0.15
});
```

### 9. 坐标全部使用英寸，不要混 cm/pt

`addText({ x: 1, y: 1, w: 8, h: 2 })` 里 1 = 1 英寸。

### 10. 图表必须设 `x/y/w/h`

漏掉任一字段图表会塌缩到 0 尺寸。

---

## 调试技巧

- 写脚本时 `try { await pres.writeFile(...) } catch (e) { console.error(e) }` 包一层，捕获 PptxGenJS 内部异常
- `pres.stream()` 返回 Buffer，方便在内存中校验
- 解包检查：`unzip -o output.pptx -d tmp/unpacked/ && ls tmp/unpacked/ppt/slides/`
