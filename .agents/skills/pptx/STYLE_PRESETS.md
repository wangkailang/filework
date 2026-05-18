# 视觉预设参考

12 个为 PptxGenJS 适配的精选视觉风格。每个预设来自真实设计参考，**避免泛 AI 美学**。

每个预设包含：
- **Vibe** — 一句话定调
- **Typography** — display + body 字体（PowerPoint 系统可用或常见 Google Fonts fallback）
- **Colors** — PptxGenJS 色值五元组（无 `#`）
- **Layout signature** — 这个预设的视觉标志
- **Anti-pattern** — 这个预设要避免的反例

按 mood 分组方便 Phase 2 匹配：

| Mood        | Presets                                        |
|-------------|------------------------------------------------|
| Impressed   | Bold Signal, Electric Studio, Charcoal Minimal |
| Excited     | Creative Voltage, Coral Vitality, Neon Cyber   |
| Calm        | Paper & Ink, Sage Tranquil, Swiss Modern       |
| Inspired    | Dark Botanical, Vintage Editorial, Berry Cream |

---

## Impressed（自信、专业、高端）

### 1. Bold Signal

**Vibe:** 自信、大胆、现代、强冲击

**Typography:** display `Archivo Black` / body `Inter`（PPT 缺字时 fallback `Arial Black` / `Calibri`）

**Colors:**
```javascript
{ primary: "FF5722", secondary: "2D2D2D", accent: "FFFFFF", bg: "1A1A1A", text: "FFFFFF" }
```

**Layout signature:**
- 暗灰渐变背景 + 一块亮橙焦点卡片占左 1/3
- 左上角大号章节编号（`01`、`02`...）40pt+ 字重 900
- 右上角导航面包屑（active/inactive 透明度对比）
- 标题落在卡片底部左下

**Anti-pattern:** 浅色背景、卡片用淡彩色、章节编号 < 30pt

---

### 2. Electric Studio

**Vibe:** 干净、专业、高对比

**Typography:** display `Manrope` 800 / body `Manrope` 400-500

**Colors:**
```javascript
{ primary: "4361EE", secondary: "0A0A0A", accent: "FFFFFF", bg: "FFFFFF", text: "0A0A0A" }
```

**Layout signature:**
- 上下双面板：白色上 / 蓝色下，比例 3:2
- 引语作为视觉主体，正文 18-24pt 大号
- 边角放小尺寸品牌标识或日期
- 极简留白

**Anti-pattern:** 双面板比例对半、加渐变、加装饰图形

---

### 3. Charcoal Minimal

**Vibe:** 炭灰极简、内敛、专业

**Typography:** display `Trebuchet MS` / body `Calibri`

**Colors:**
```javascript
{ primary: "36454F", secondary: "F2F2F2", accent: "212121", bg: "F2F2F2", text: "36454F" }
```

**Layout signature:**
- 浅灰底 + 炭灰字 + 黑色细线分隔（线宽 1pt）
- 标题左对齐顶部，正文 60% 留白
- 装饰元素仅用细线、不用色块

**Anti-pattern:** 加亮色强调（违背极简）、标题下加装饰横线（AI slop 标志）

---

## Excited（活力、创新、大胆）

### 4. Creative Voltage

**Vibe:** 大胆、创意、复古现代

**Typography:** display `Syne` 700-800 / body `Space Mono` 400-700

**Colors:**
```javascript
{ primary: "0066FF", secondary: "1A1A2E", accent: "D4FF00", bg: "0066FF", text: "FFFFFF" }
```

**Layout signature:**
- 左侧电光蓝 + 右侧暗夜深紫 5:5 分割
- 霓虹黄做按钮/标签强调
- 半色调网点纹理做背景装饰

**Anti-pattern:** 用平淡的蓝/灰、字体改用 sans-serif、放弃霓虹黄强调

---

### 5. Coral Vitality

**Vibe:** 珊瑚活力、温暖、社交

**Typography:** display `Poppins` 700 / body `Poppins` 400

**Colors:**
```javascript
{ primary: "F96167", secondary: "F9E795", accent: "2F3C7E", bg: "FFFFFF", text: "2F3C7E" }
```

**Layout signature:**
- 白底 + 珊瑚红主色 + 米黄辅色 + 深蓝强调
- 圆角形状（`ROUNDED_RECTANGLE`，`rectRadius: 0.15`）
- 数据卡片用米黄填充 + 珊瑚红边框

**Anti-pattern:** 改成直角矩形、配色平均分布（违反 60/30/10）

---

### 6. Neon Cyber

**Vibe:** 赛博朋克、科技感、未来

**Typography:** display `Orbitron` / body `Space Grotesk`

**Colors:**
```javascript
{ primary: "00F0FF", secondary: "FF00E5", accent: "FFFF00", bg: "0A0014", text: "00F0FF" }
```

**Layout signature:**
- 深紫黑底 + 青蓝/品红/亮黄三向霓虹
- 文字加发光（PPT 用 `glow`：`{ size: 8, color: "00F0FF", opacity: 0.4 }`）
- 网格线背景（用细 LINE 形状画 50px 间距）

**Anti-pattern:** 浅色背景、字体用衬线、降低饱和度

---

## Calm（冷静、清晰、深思）

### 7. Paper & Ink

**Vibe:** 纸墨、出版物、克制

**Typography:** display `Georgia` / body `Garamond`

**Colors:**
```javascript
{ primary: "1A1A1A", secondary: "8B7E6F", accent: "B85042", bg: "F5EFE7", text: "1A1A1A" }
```

**Layout signature:**
- 米黄纸张底色 + 黑字 + 砖红强调
- 衬线字体，正文小号 12-14pt 严谨排版
- 装饰元素仅用细线、罗马数字、引号

**Anti-pattern:** 改用 sans-serif、加色块背景、用大号字

---

### 8. Sage Tranquil

**Vibe:** 鼠尾草、平静、自然

**Typography:** display `Cormorant Garamond` / body `Inter`

**Colors:**
```javascript
{ primary: "84B59F", secondary: "69A297", accent: "50808E", bg: "F4F1EA", text: "2C3E40" }
```

**Layout signature:**
- 米色奶油底 + 三层鼠尾草绿渐进
- 大量留白（每个文本块 ≤ 60% 页面）
- 圆形装饰元素（OVAL）

**Anti-pattern:** 高饱和强调色、密集排版、矩形装饰

---

### 9. Swiss Modern

**Vibe:** 瑞士国际风、网格、严谨

**Typography:** display `Helvetica` / body `Helvetica`（fallback `Arial`）

**Colors:**
```javascript
{ primary: "FF0000", secondary: "000000", accent: "FFFFFF", bg: "FFFFFF", text: "000000" }
```

**Layout signature:**
- 严格网格对齐（6 栏或 12 栏）
- 仅黑/白/红三色
- 大号无衬线 + 极少装饰
- 标题左对齐顶部，正文左对齐

**Anti-pattern:** 加渐变、加阴影、加装饰图形（违背瑞士派纯粹性）

---

## Inspired（情感、记忆、艺术）

### 10. Dark Botanical

**Vibe:** 暗调植物、优雅、艺术、高端

**Typography:** display `Playfair Display` / body `Lato`

**Colors:**
```javascript
{ primary: "2C5F2D", secondary: "97BC62", accent: "D4AF37", bg: "0F1A0E", text: "F5F5F5" }
```

**Layout signature:**
- 深绿夜色底 + 浅绿/金色点缀
- 大号衬线标题 60-80pt 居中
- 角落放植物剪影（base64 SVG）

**Anti-pattern:** 改用亮色底、字体改 sans-serif、加几何形装饰

---

### 11. Vintage Editorial

**Vibe:** 复古杂志、编辑感、文化

**Typography:** display `Playfair Display` / body `Lora`

**Colors:**
```javascript
{ primary: "990011", secondary: "FCF6F5", accent: "2F3C7E", bg: "FCF6F5", text: "1A1A1A" }
```

**Layout signature:**
- 米白纸 + 深红 drop cap + 深蓝强调
- 双栏正文（addText 用两个并列文本框模拟）
- 引语用大号斜体衬线 + 引号装饰

**Anti-pattern:** 单栏排版、字体改 sans-serif、降低对比度

---

### 12. Berry Cream

**Vibe:** 浆果奶油、温柔、女性、温暖

**Typography:** display `Fraunces` / body `DM Sans`

**Colors:**
```javascript
{ primary: "6D2E46", secondary: "A26769", accent: "ECE2D0", bg: "FFF8F0", text: "3D1F2D" }
```

**Layout signature:**
- 米白奶油底 + 紫莓主色 + 暖灰辅色
- 圆角卡片 + 柔和阴影
- 大号衬线 + 小号 sans 正文

**Anti-pattern:** 用冷色调强调、加直角硬边、缩小标题字号

---

## 使用规则

### 选色三七律

**主色 60-70% / 辅色 20-30% / 强调色 5-10%**。不要均分。强调色仅用在：CTA 按钮、关键数字、活动状态指示。

### 字号阶梯

| 元素 | 字号 |
|------|------|
| 标题页主标题 | 60-80pt 粗体 |
| 内页标题 | 36-44pt 粗体 |
| 章节标题 | 20-24pt 粗体 |
| 正文 | 14-16pt |
| 注释/页脚 | 10-12pt |

### 字体可用性 fallback

PowerPoint 系统未必装了 Google Fonts。在 PptxGenJS 中可写：

```javascript
fontFace: "Playfair Display, Georgia, serif"
```

或在生成前判断目标系统，二选一。

### 跨预设禁用项

无论选哪个预设，**都不要**：

- 标题下加装饰横线（AI slop 第一标志）
- 默认蓝色（除非预设本身就是蓝色，例如 Electric Studio）
- 居中正文段落（标题可居中，正文左对齐）
- 在同一页面用三种以上字体
- 用 Inter / Calibri 当所有页面的唯一字体
- 紫粉渐变（AI slop 第二标志）
