# Workspace Agent · 设计系统(Instrument)

> **状态**:✅ 已采纳并落地中 —— token 已写入 `src/renderer/global.css` 的 `@theme`。
> **方向**:Instrument(仪表盘/工作台)。本质是「驾驭强力 Agent 的控制台」,情绪=掌控/可信/快/专注。
> **日期**:2026-06-05 · 取代 2026-03 旧版皮肤。
> **结构基础**:`docs/superpowers/specs/2026-05-29-ui-layout-redesign-design.md`(三区布局;那次「不换肤」,本规范补皮肤)。

## 设计原则

1. **桌面原生感**:遵循 macOS,不像 Web 应用。
2. **暗色优先**:开发者/知识工作者偏好暗色;light 为次要主题。
3. **操作可见**:Agent 状态与审批门控像仪表读数一样可感(签名时刻)。
4. **精密仪表感**:mono 共同主字体 + 发丝边 + 内凹输入 + 收紧圆角 + 网格氛围,拒绝「消费级 SaaS 卡片堆」。

---

## 颜色 token(`@theme`,命名即代码)

> Tailwind v4:每个 `--color-X` 自动生成 `bg-X` / `text-X` / `border-X` 工具类。透明度用修饰符(`bg-primary/10`、`border-primary/25`),不另立 token。

### 暗色(默认)

| Token | 值 | 用途 / 工具类 |
|---|---|---|
| `--color-background` | `#0a0b0e` | 最底背景(冷石墨) |
| `--color-foreground` | `#e7eaef` | 主文字 |
| `--color-surface` | `#101319` | 面板:rail / dock |
| `--color-surface-sunken` | `#07080b` | 内凹输入底(配 `.surface-sunken`) |
| `--color-card` / `--color-popover` | `#151921` | 卡片 / 浮层 |
| `--color-secondary` | `#1b2029` | 次级块 |
| `--color-accent` | `#1b2029` | hover / 选中底 |
| `--color-muted` | `#181c23` | 次要底 |
| `--color-muted-foreground` | `#98a0ac` | 次要字 |
| `--color-primary` | `#a78bfa` | **信号紫**:交互/选中/链接/发送键 |
| `--color-primary-foreground` | `#1a1033` | 紫底上的深色字 |
| `--color-primary-bright` | `#c4b5fd` | hover 提亮 |
| `--color-border` | `#21262f` | 发丝边主值 |
| `--color-border-strong` | `#2c333e` | hover / open 边 |
| `--color-border-faint` | `#181c23` | 分隔线 |
| `--color-ring` | `#a78bfa` | focus 环 |
| `--color-destructive` | `#f06a76` | 危险操作 |

### ★ 状态系统(Agent 状态语义,全局统一)

> 同一状态在 telemetry 条 / 工具卡 / 审批卡 / 分支 chip 用同一套色与处理。**状态不只靠颜色**,必带文字或图标。

| 状态 | Token | 暗色值 |
|---|---|---|
| idle | `--color-status-idle` | `#6b7480` |
| running | `--color-status-running` | `#a78bfa` |
| awaiting(待审批) | `--color-status-await` | `#f5b133`(按钮深字 `--color-status-await-foreground` `#1a1407`) |
| success | `--color-status-success` | `#3fcf8e` |
| error | `--color-status-error` | `#f06a76` |

### 文件类型色(冷调)

`--color-file-folder #f0b144` · `--color-file-code #5b9cff` · `--color-file-doc #3fcf8e` · `--color-file-image #e879c9` · `--color-file-data #f5995b` · `--color-ai-thinking #a78bfa` · `--color-ai-success #3fcf8e`

### Light

`.light` 提供完整对应覆盖(暖中性纸 `#f8f8f6` / 墨 `#16181d`,主色与状态色加深一档保对比)。dark 为主,light 已可用。

---

## 字体

| Token | 值 |
|---|---|
| `--font-sans` | `"Inter", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif` |
| `--font-mono` | `"JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace` |

- **mono 是共同主角**,以下位置一律 `font-mono` + `tabular-nums`(数字):文件路径、工具名与参数、分支 chip、会话时间/turn 数、telemetry 全部、token/耗时、代码/diff。
- 正文(对话)`text-sm`~14px、`leading-relaxed`,借「静谧」阅读节奏。
- ⏳ **待办**:Inter / JetBrains Mono 尚未 self-host;当前靠系统回退(mac 上 SF Mono / SF Pro,观感已可)。正式版应把 woff2 打进 `src/renderer/assets/fonts` + `@font-face`,不引 CDN(Electron 离线 + 防 FOUT)。

---

## 形状 · 表面 · 动效

- **圆角**(收紧):`--radius-xs 3px` · `--radius-sm 5px` · `--radius-md 7px` · `--radius-lg 9px`。
- **发丝边**:统一 `border` 1px;hover/open 升 `border-strong`;分隔用 `border-faint`。
- **内凹输入**:用 `.surface-sunken`(内阴影 + 内描边),focus 叠 `ring`/primary 光圈。
- **阴影**:仅浮层(窄窗 Dock 抽屉、菜单)用 `0 8px 24px rgba(0,0,0,.4)`;平面区靠表面分层 + 发丝边分层级,不滥用投影。
- **间距**:Tailwind 4px 网格;组件内紧凑;对话列 `max-width ~720` 居中。
- **动效 token**:`ease-snap`(`cubic-bezier(.2,0,0,1)` 机械感)· `ease-settle`(入场)· `animate-rise`(消息浮起)· `animate-ping-ring`(状态灯脉冲)· `animate-scan`(telemetry 扫描)· `animate-eq`(均衡器)。一段有方向的载入 > 二十个随机 hover。尊重 `prefers-reduced-motion`(全局降级已在 css)。
- **背景**:对话阅读区与空状态(welcome)均**保持纯净纯色背景,不铺网格/纹理/渐变**——实测网格会干扰阅读,空状态也不需要(用户反馈)。

---

## 交互约定(全局一致)

> 原则:有反馈、可键盘、动效只加「有方向」的,不散落 hover 花活。

- **focus**:可交互元素统一 `focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50`(贴边元素用 `focus-visible:ring-inset` + `/40`)。
- **按压反馈**:主操作键 `active:scale-95`(卡内按钮 `active:scale-[0.98]`)+ `transition-all`,给机械触感;发送键 = primary 实心。
- **入场 / 过渡(统一节奏,连贯优先)**:结构性出现统一走 `animate-in fade-in-0 [zoom-in-95 | slide-in-*] duration-150~200` —— 消息 `animate-rise`、命令面板与**所有模态**(遮罩 `fade-in` + 面板 `zoom-in-95`)、Dock 打开 `slide-in-from-right`、折叠卡片展开 `slide-in-from-top`、tab 指示条 `fade-in`;状态色用 `transition-colors`(telemetry 状态 morph)。一段有方向的过渡 > 散落的微交互;不给所有东西加动画。
- **键盘操作**:浮层 / 下拉 / 菜单一律 **Esc 关闭**;单工具审批支持 **`⌘↵` 批准 / `⌘⌫` 拒绝**(焦点在输入框时不拦截,避免误批敏感操作)。
- **效率入口**(对标 Codex / Claude Desktop):**`⌘K` 命令面板**聚合常用动作(新对话 / Dock 各标签 / 设置 / 切换工作区);composer **`@` 引用工作区文件**(native `searchFiles` 检索,插入 `@相对路径`);**全局 toast**(`sonner`,样式跟随 token、错误/成功仅描边着色)反馈瞬时结果与错误。
- 全部尊重 `prefers-reduced-motion`(已全局降级)。

---

## 组件规范

> 类名/结构以 `src/renderer/components` 下实际组件为准。

- **★ Agent Telemetry 状态条(签名 · 新增)**:ConversationArea 顶部常驻细条。`[状态灯+词] · [当前动作:工具·参数] … [均衡器][token][耗时][模型]`,整条 mono;状态走状态系统,running 时灯脉冲 + 扫描光 + 均衡器跳。接 agent-loop 当前状态/工具/token/起始时间/模型。
- **工具卡 `Tool`**:折叠单行 `▸ 工具名 参数 … 状态徽标`;展开 tbody(`surface-sunken` 底、mono、行号)。open 升 `border-strong`。
- **审批卡 `Approval`**:待批=`status-await` 边 + `/10` 底 + 盾形图标 + mono 标题;批准键=琥珀实心深字,拒绝=描边 hover 转 error;已决归一到 card 底、标题转 success。
- **消息/推理**:头部 mono 小字大写 `USER`/`AGENT` + 角标(ai=primary 描边);正文 14px;推理块左 2px `border-strong` 折叠。
- **输入框 `Composer`**:`.surface-sunken`,focus 叠 primary 光圈;发送键=primary 实心方块 active 缩放。
- **LeftRail / Dock / 分支 chip**:面板 `surface` 底;tab 选中下 2px primary 辉光条;会话项 hover `accent`、选中加发丝边、时间/turn mono;分支=mono pill + success 圆点。

---

## 落地状态

- ✅ **Stage A**:`global.css` `@theme` 全量 token(色/状态/字体栈/圆角/缓动/动画)+ `.light` + `.bg-grid-texture` / `.surface-sunken` + reduced-motion。构建已通过。
- ⏳ **Stage B**:本规范(canonical)。
- ⏳ **Stage C**:Telemetry 组件 + Tool/Approval/Composer/Rail/Dock 重做样式(逻辑不动)。
- ⏳ **后续**:self-host 字体。

## 可达性

- 对比:`foreground`/`background` ≈ 15:1;`muted-foreground` ≥ 4.5:1;琥珀按钮配深字。
- 状态不只靠色(带文字/图标),色盲可辨。
- 动效尊重 `prefers-reduced-motion`(已全局降级)。
- 键盘可达 + 拖拽区 `titlebar-no-drag` 沿用布局规范。

## 维护

后续任何 UI 改动遵循本规范与 `global.css` 的 token;**新增颜色/圆角/动效一律走 `@theme` token,不写魔法值**。改 token 即全局生效。
