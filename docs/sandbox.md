# 命令执行沙箱(Shell Sandbox)

Agent 的 `runCommand` 工具在 **OS 内核沙箱**内执行 shell 命令,并配合**审批策略**
决定何时打断用户。设计对齐 Codex CLI / Claude Code 的两层模型。

> 实现全程纯 TypeScript —— 沙箱通过 fork 系统自带的 `sandbox-exec`(macOS)落地,
> 不引入 Rust / native addon。

## 为什么

历史上 agent 通过 `spawn(command, [], { shell: true })` **裸调用**系统 shell,
子进程继承 Electron 父进程的全部权限,边界仅靠应用层目录检查
(`approval-utils.ts` 的 `isInWorkspace`、`local-workspace.ts` 的 `resolveInside`)。
模型一旦生成越界写或 `curl … | sh`,内核层面没有兜底;网络完全敞开。

## 两层模型

| 层 | 关心什么 | 落地 |
|---|---|---|
| **沙箱(SandboxMode)** | 命令*技术上能做什么* | OS 内核强制(macOS Seatbelt) |
| **审批(ApprovalPolicy)** | *何时弹窗打断你* | `beforeToolCall` 钩子 |

两层解耦:沙箱负责"就算模型选错命令也跑不出去",审批负责"什么时候需要你点确认"。

### SandboxMode

| 值 | 含义 |
|---|---|
| `read-only` | 不能写任何文件(除 /dev 标准设备),不能联网 |
| `workspace-write`(默认) | 仅 workspace 可写,默认禁网 |
| `danger-full-access` | 不启用沙箱,等同裸调用 |

### ApprovalPolicy

| 值 | 含义 |
|---|---|
| `untrusted` | 每条命令执行前都弹窗(≈ 旧行为) |
| `on-request`(默认) | 仅当命令申请提权(`escalatePermissions`)时弹窗 |
| `on-failure` | 沙箱内直接执行,失败后再询问 |
| `never` | 从不弹窗,仅靠沙箱兜底 |

默认 `workspace-write` + `on-request`,贴近 Codex Auto 预设,开箱即安全。

## 执行流

```
runCommand(args)
  ├─ beforeToolCall(approval-hook):按 ApprovalPolicy + 沙箱是否生效决定弹不弹窗
  │    ├─ escalatePermissions=true → 一律弹窗(展示 justification),批准后无沙箱执行
  │    ├─ 沙箱真生效 + 策略≠untrusted → 免弹窗
  │    └─ 沙箱无效(如非 macOS)→ 强制弹窗兜底
  └─ tool.execute → 构造 SandboxPolicy
       ├─ 前台:workspace.exec.run(cmd, { sandbox })
       └─ 后台:spawnBackgroundShell(cmd, cwd, { sandbox })
            └─ getSandboxLauncher(policy).buildSpawn(cmd)
                 ├─ darwin            → sandbox-exec -p <profile> /bin/bash -c <cmd>
                 └─ 其它 / danger档   → passthrough(裸 shell,等价旧行为)
```

**关键安全点**:`approval-hook` 与 `runCommand` 共享全局设置。沙箱无效的平台上
(非 macOS)即便策略宽松也**强制逐条弹窗**,避免"无沙箱又免弹窗"的绕过。

## Seatbelt profile

macOS 用 SBPL,语义是"最后匹配的规则生效":

```scheme
(version 1)
(allow default)              ; 读、exec、读系统库等放开
(deny file-write*)           ; 默认禁止一切写
(allow file-write*           ; 再放开标准设备 + (workspace-write 档)可写根
  (literal "/dev/null") ...
  (subpath "<realpath(workspace)>")
  (subpath "<realpath(os.tmpdir())>"))
(deny network*)              ; allowNetwork=false 时追加
```

`writableRoots` 必须是 **realpath 解析后**的绝对路径(macOS `/tmp` → `/private/tmp`、
软链接 workspace),否则 subpath 前缀匹配会失效。

## 设置

存于 SQLite `settings` 表,key=`sandboxMode` / `approvalPolicy`。
设置页"命令执行安全"面板(`CommandSecurityPanel`)提供两个下拉切换;
后端经 `resolveSandboxConfig` / `resolveApprovalPolicy` 解析,非法/缺省回落默认值。

## 提权(escalation)

模型在确实需要联网或写出 workspace 时,在 `runCommand` 设置:

```ts
{ command: "pnpm install", escalatePermissions: true, justification: "需要联网安装依赖" }
```

→ 触发审批弹窗(展示 justification),批准后该次命令以 `danger-full-access`
(无沙箱)执行。

## 平台支持

| 平台 | 沙箱 |
|---|---|
| macOS | ✅ Seatbelt(`sandbox-exec`) |
| Linux | ⏳ passthrough + 强制弹窗(Phase 4 拟接 `bwrap`) |
| Windows | passthrough + 强制弹窗 |

## 关键文件

- `src/main/core/sandbox/types.ts` — 类型(SandboxMode / SandboxPolicy / ApprovalPolicy / SandboxLauncher)
- `src/main/core/sandbox/seatbelt-profile.ts` — `buildSeatbeltProfile`
- `src/main/core/sandbox/index.ts` — `getSandboxLauncher` / `isSandboxEffective` / `resolveSandboxConfig` / `resolveApprovalPolicy` / `resolveWritableRoots`
- `src/main/core/workspace/local-workspace.ts` — 前台 `exec.run` 注入点
- `src/main/core/agent/shells.ts` — 后台 `spawnBackgroundShell` 注入点
- `src/main/core/agent/tools/index.ts` — `runCommand` schema(escalation 字段)+ policy 构造
- `src/main/ipc/agent-tools.ts` — 从设置读取 sandbox 配置注入工具
- `src/main/ipc/approval-hook.ts` — 审批策略决策 + escalation
- `src/renderer/components/settings/CommandSecurityPanel.tsx` — 设置 UI

## 验证

- 单测:`src/main/core/sandbox/__tests__/seatbelt-profile.test.ts`(profile 生成、launcher 选择、配置解析)
- 真实沙箱(macOS):
  ```bash
  WS=$(mktemp -d); P="(version 1)(allow default)(deny file-write*)(allow file-write* (literal \"/dev/null\") (subpath \"$WS\"))(deny network*)"
  /usr/bin/sandbox-exec -p "$P" /bin/bash -c "echo ok > $WS/a.txt"        # 成功
  /usr/bin/sandbox-exec -p "$P" /bin/bash -c "echo x > $WS/../b.txt"      # Operation not permitted
  /usr/bin/sandbox-exec -p "$P" /bin/bash -c "curl -m5 https://example.com" # 失败(禁网)
  ```

## 后续(可选)

- **Phase 4**:Linux `bwrap` 后端(fork 系统工具,同样纯 TS;不做需要 native 的 Landlock+seccomp 细粒度档)。
- **Phase 5**:网络域名白名单 —— 沙箱内禁直连 + 本地 forward proxy 按域名放行(同 Claude Code),可复用 `git-proxy-env.ts` / `proxy-bootstrap.ts`。
