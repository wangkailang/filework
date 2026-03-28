---
name: agent-browser
description: >
  使用 agent-browser CLI 进行浏览器自动化。涵盖：打开网页、截图、获取页面快照（无障碍树）、
  点击/填写/选择等交互操作、表单提交、Cookie 管理、网络拦截、多标签页控制、
  登录认证与会话持久化、视觉回归对比。当用户提到浏览器自动化、网页抓取、截图、
  网页测试、爬虫、页面交互、表单填写、登录流程、E2E 测试时触发此技能。
context: fork
allowed-tools:
  - readFile
  - writeFile
  - createDirectory
  - runCommand
user-invocable: true
disable-model-invocation: false
requires:
  bins:
    - npx
hooks:
  pre-activate: npx agent-browser install
---

# Agent Browser 技能

通过 `agent-browser` CLI 实现无头浏览器自动化，基于 Playwright + Rust 原生二进制。

## 核心工作流（AI 最佳实践）

始终遵循 **snapshot → ref → action** 模式：

```bash
# 1. 打开页面
npx agent-browser open <url>

# 2. 获取无障碍树快照（带 ref 标识）
npx agent-browser snapshot -i

# 3. 使用 ref 交互
npx agent-browser click @e2
npx agent-browser fill @e3 "text"

# 4. 页面变化后重新获取快照
npx agent-browser snapshot -i
```

规则：
- 每次页面变化后必须重新 `snapshot` 获取新的 ref
- 优先使用 `-i` 参数只获取可交互元素，减少输出量
- 使用 `--json` 获取机器可读输出
- 操作完成后执行 `npx agent-browser close` 关闭浏览器

## 命令速查

### 导航

```bash
npx agent-browser open <url>          # 打开页面
npx agent-browser back                # 后退
npx agent-browser forward             # 前进
npx agent-browser reload              # 刷新
npx agent-browser close               # 关闭浏览器
```

### 交互

```bash
npx agent-browser click <sel>         # 点击（sel 可以是 @ref、CSS 选择器、text=...）
npx agent-browser fill <sel> <text>   # 清空并填写
npx agent-browser type <sel> <text>   # 追加输入
npx agent-browser press <key>         # 按键（Enter, Tab, Control+a）
npx agent-browser select <sel> <val>  # 下拉选择
npx agent-browser check <sel>         # 勾选
npx agent-browser uncheck <sel>       # 取消勾选
npx agent-browser hover <sel>         # 悬停
npx agent-browser scroll <dir> [px]   # 滚动（up/down/left/right）
npx agent-browser upload <sel> <files> # 上传文件
```

### 信息获取

```bash
npx agent-browser snapshot            # 完整无障碍树
npx agent-browser snapshot -i         # 仅可交互元素
npx agent-browser snapshot -i -c      # 紧凑模式
npx agent-browser snapshot -i -c -d 5 # 限制深度
npx agent-browser screenshot [path]   # 截图
npx agent-browser screenshot --annotate # 带标注的截图
npx agent-browser get text <sel>      # 获取文本
npx agent-browser get html <sel>      # 获取 HTML
npx agent-browser get value <sel>     # 获取输入值
npx agent-browser get title           # 获取页面标题
npx agent-browser get url             # 获取当前 URL
npx agent-browser get count <sel>     # 计数匹配元素
npx agent-browser pdf <path>          # 保存为 PDF
```

### 等待

```bash
npx agent-browser wait <selector>         # 等待元素可见
npx agent-browser wait <ms>               # 等待毫秒
npx agent-browser wait --text "Welcome"   # 等待文本出现
npx agent-browser wait --url "**/dash"    # 等待 URL 匹配
npx agent-browser wait --load networkidle # 等待网络空闲
```

### 语义定位器（find）

```bash
npx agent-browser find role button click --name "Submit"
npx agent-browser find text "Sign In" click
npx agent-browser find label "Email" fill "test@test.com"
npx agent-browser find placeholder "搜索" fill "关键词"
npx agent-browser find testid "login-btn" click
```

### 标签页

```bash
npx agent-browser tab                 # 列出标签页
npx agent-browser tab new [url]       # 新标签页
npx agent-browser tab <n>             # 切换到第 n 个
npx agent-browser tab close [n]       # 关闭标签页
```

### Cookie 与存储

```bash
npx agent-browser cookies             # 查看所有 Cookie
npx agent-browser cookies set <n> <v> # 设置 Cookie
npx agent-browser cookies clear       # 清除 Cookie
npx agent-browser storage local       # 查看 localStorage
npx agent-browser storage local set <k> <v>
```

### 网络拦截

```bash
npx agent-browser network route <url> --abort    # 拦截并阻止
npx agent-browser network route <url> --body <j> # Mock 响应
npx agent-browser network requests               # 查看请求记录
npx agent-browser network requests --filter api  # 过滤请求
```

### 对比（Diff）

```bash
npx agent-browser diff snapshot                          # 与上次快照对比
npx agent-browser diff screenshot --baseline before.png  # 视觉像素对比
npx agent-browser diff url https://v1.com https://v2.com # 两个 URL 对比
```

### 调试

```bash
npx agent-browser console             # 查看控制台消息
npx agent-browser errors              # 查看页面错误
npx agent-browser highlight <sel>     # 高亮元素
npx agent-browser eval <js>           # 执行 JavaScript
```

## 会话与认证

### 会话隔离

```bash
npx agent-browser --session agent1 open site-a.com
npx agent-browser --session agent2 open site-b.com
```

### 持久化 Profile（跨重启保留登录状态）

```bash
npx agent-browser --profile ~/.myapp-profile open myapp.com
# 登录一次后，后续启动自动恢复会话
```

### 会话名持久化（自动保存/恢复 Cookie）

```bash
npx agent-browser --session-name twitter open twitter.com
```

### 认证状态导入/导出

```bash
# 保存当前认证状态
npx agent-browser state save ./auth.json
# 加载认证状态
npx agent-browser --state ./auth.json open https://app.example.com
```

### 带认证头访问

```bash
npx agent-browser open api.example.com --headers '{"Authorization": "Bearer <token>"}'
```

## 浏览器设置

```bash
npx agent-browser set viewport 1280 720       # 设置视口
npx agent-browser set device "iPhone 14"       # 模拟设备
npx agent-browser set geo 39.9 116.4           # 设置地理位置
npx agent-browser set offline on               # 离线模式
npx agent-browser set media dark               # 暗色模式
```

## 自动执行流程

执行浏览器任务时遵循以下流程：

1. `npx agent-browser open <url>` 打开目标页面
2. `npx agent-browser wait --load networkidle` 等待加载完成
3. `npx agent-browser snapshot -i` 获取可交互元素
4. 根据快照中的 ref 执行交互操作
5. 每次页面变化后重新 snapshot
6. 任务完成后 `npx agent-browser close`

错误处理：
- 如果元素未找到，重新 snapshot 确认 ref 是否变化
- 如果页面未加载，增加 wait 时间或使用 `wait --load networkidle`
- 如果超时，检查网络状态或使用 `--headed` 模式调试
- 截图保存失败时检查路径权限

## 常见陷阱

1. **ref 会过期** — 页面变化后必须重新 snapshot 获取新 ref
2. **npx 比全局安装慢** — 频繁使用建议 `npm install -g agent-browser`
3. **默认超时 25 秒** — 慢页面可设置 `AGENT_BROWSER_DEFAULT_TIMEOUT=45000`
4. **关闭浏览器** — 任务结束务必 `close`，避免残留进程
5. **state 文件含敏感信息** — 加入 `.gitignore`，不要提交
