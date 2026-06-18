# MCP 认证

本文档说明 Workspace Agent 的 MCP 服务器认证设计、运行链路和自测方法。

## 范围

MCP 服务器按 transport 分为两类:

- `stdio`: 本地命令启动的 MCP 服务器,认证由该服务器自己的环境变量或配置文件处理。
- `http`: 远程 MCP 服务器,支持自动 OAuth 发现、手动 OAuth 兜底,也支持完全关闭 OAuth 后用静态 headers。

`stdio` 不走 MCP OAuth。比如邮箱 MCP、GitHub 本地 MCP、文件系统 MCP 这类服务,通常通过 `env` 配置 API key、邮箱授权码或 token。敏感值优先使用 `${env:VAR}` 引用,避免把真实密钥写入数据库配置。

## 认证模式

HTTP MCP 使用三种认证模式:

| 模式 | 用途 | 行为 |
| --- | --- | --- |
| `auto` | 默认模式 | 挂载 MCP SDK OAuth provider,连接时静默发现认证需求。需要登录时只显示授权入口,不会自动打开浏览器。 |
| `oauth` | 高级兜底 | 和 `auto` 一样走 OAuth provider,但允许用户显式填 scopes / client id / client secret。 |
| `none` | 静态凭据或无认证 | 不挂 OAuth provider。可用 `headers` 传 `Authorization: Bearer ${env:TOKEN}`。 |

新建或导入 HTTP MCP 时,未显式声明 `authType` 的配置默认使用 `auto`。老配置中已经保存为 `none` 或 `oauth` 的行保持原行为,避免升级后改变用户已有服务器的认证方式。

## 运行流程

HTTP OAuth 的端到端链路:

1. 渲染进程在 MCP 设置面板中收集配置。
2. Preload 调用 `window.filework.mcp.addServer/updateServer/importJson`。
3. `src/main/ipc/mcp-handlers.ts` 规范化输入:
   - HTTP 未声明认证时使用 `authType: "auto"`。
   - `auth: "oauth"` / `authType: "oauth"` 保持显式 OAuth。
   - `authType: "none"` 关闭 OAuth。
   - OAuth client secret 不返回给渲染进程,只返回 `oauthClientSecretConfigured`。
4. `src/main/db/index.ts` 持久化配置:
   - `mcp_servers.auth_type`: `auto | none | oauth`
   - `mcp_servers.oauth_scopes`: JSON 字符串数组
   - `mcp_servers.oauth_client_id`: 可选字符串
   - `mcp_servers.oauth_client_secret`: 加密字符串
   - `mcp_oauth_sessions.encrypted_session`: 加密后的动态 client / token / PKCE / discovery state。默认 `auto` 优先使用 Electron `safeStorage` 提供的系统钥匙串加密能力;不可用时回退到现有本地数据库加密。
5. `src/main/mcp/manager.ts` 为每个 server 创建 `McpClient`,并注入 OAuth session store。
6. `src/main/mcp/client.ts` 创建 transport:
   - `authType !== "none"` 时给 `StreamableHTTPClientTransport` 挂 `authProvider`。
   - 初次连接使用 `interactive: false`,只做静默发现,不会打开浏览器。
   - 连接超时默认 20s,超时会关闭 transport 并返回错误态,避免 UI 一直 loading。
7. 如果 SDK 在静默连接时生成了 authorization URL,`McpClient` 抛出 `McpAuthorizationRequiredError`。
8. Manager 把 server 状态设为未连接,并写入结构化认证状态:
   - `authStatus`: `not_applicable | unknown | needs_auth | authorizing | authenticated | expired | error`
   - `authMessage`: 面向 UI 的认证错误或提示
   - `authErrorCode`: 面向可观测和排障的机器可读失败分类
   - `authUrl`: 静默发现得到的授权 URL
   旧字段 `connected` / `connecting` / `lastError` 继续保留,用于兼容连接状态展示。
9. 渲染进程根据 `authStatus` 展示显式 `Authorize/授权` 按钮,而不是依赖主进程拼接英文提示。
10. 用户点击授权按钮后调用 `mcp:authorize`:
   - 主进程启动本地 callback server。
   - 重新创建 interactive OAuth provider。
   - SDK `auth()` 打开浏览器。
   - callback 收到 `code` 后完成 token 交换。
   - token/session 加密保存。
   - server 自动重连。

## 全局 OAuth 设置

MCP 面板提供 `OAuth 设置`,对应以下 settings key:

| key | 默认值 | 说明 |
| --- | --- | --- |
| `mcp.oauth.credentialsStore` | `auto` | OAuth session 存储加密后端。可选 `auto`、`keychain`、`database`。`auto` 会优先使用钥匙串能力,失败时回退数据库加密。 |
| `mcp.oauth.callbackHost` | `127.0.0.1` | 本地 OAuth callback 监听 host。只接受 `127.0.0.1`、`localhost`、`::1`,其他值会被规范化为 `127.0.0.1`。 |
| `mcp.oauth.callbackPort` | `0` | 本地 OAuth callback 端口。`0` 表示由系统自动分配可用端口。需要在第三方 OAuth App 中预注册固定 redirect URI 时,可设置为固定端口。 |
| `mcp.oauth.callbackPath` | `/callback` | 本地 OAuth callback 路径。会自动补齐开头的 `/`。 |

使用固定 callback 时,最终 redirect URI 形如:

```text
http://127.0.0.1:54321/mcp/callback
```

如果使用动态客户端注册,通常保持端口 `0` 即可。如果服务商要求预注册 redirect URI,则建议固定端口和路径,并在该服务商控制台中登记完全一致的 URI。

## 清除授权

用户点击 `Clear authorization/清除授权` 时:

1. 主进程断开该 server 的当前 MCP client。
2. 删除 `mcp_oauth_sessions` 中对应 server 的 OAuth session。
3. 将结构化状态重置为 `authStatus: "unknown"`。
4. 若 server 仍启用,后台重新连接一次;需要登录的 server 会回到 `needs_auth` 状态并展示授权入口。

这个动作不会删除 MCP server 配置,也不会删除手动填写的 `oauthClientId` / scopes / headers。

## 交互规则

- 自动认证不能自动弹浏览器。只有用户点击 `Authorize/授权` 才能打开外部浏览器。
- 错误区域必须显示可点击的文字授权按钮,不能只依赖图标按钮。
- 认证或连接失败不能让 server 长期停留在 `connecting=true`。连接阶段有 20s 超时保护。
- 清除授权只在 `authStatus: "authenticated"` 时显示;执行后不能遗留旧 token。
- `auto` 是普通用户默认路径;scopes / client id / client secret 是高级兜底项。
- `stdio` server 不显示 OAuth 认证选项。

## 授权失败可观测性

认证失败时,运行时状态会同时提供面向人的 `authMessage` 和面向程序的 `authErrorCode`。UI 会在错误提示旁显示错误代码,IPC 事件 `mcp:server-status-changed` 也会携带该字段,便于日志、测试和问题反馈定位。

当前失败分类:

| `authErrorCode` | 典型场景 |
| --- | --- |
| `authorization_failed` | OAuth discovery、动态客户端注册或打开授权前失败。 |
| `callback_listener_failed` | 本地 callback server 端口被占用或无法监听。 |
| `callback_timeout` | 用户没有在 5 分钟内完成浏览器授权回跳。 |
| `callback_error` | 服务商 callback 返回 `error` 或缺少授权码。 |
| `state_mismatch` | callback `state` 与本地保存值不一致。 |
| `token_exchange_failed` | 使用授权码交换 token 失败。 |
| `connection_failed` | 已有 token 或静默连接阶段的 HTTP transport / MCP 连接失败。 |

## 配置示例

### 远程 HTTP MCP,自动 OAuth

```json
{
  "mcpServers": {
    "vercel": {
      "url": "https://mcp.vercel.com"
    }
  }
}
```

导入后会保存为:

```json
{
  "name": "vercel",
  "transport": "http",
  "url": "https://mcp.vercel.com",
  "authType": "auto"
}
```

### 远程 HTTP MCP,手动 OAuth 兜底

```json
{
  "mcpServers": {
    "asana": {
      "url": "https://mcp.asana.com/v2/mcp",
      "authType": "auto",
      "oauthClientId": "${env:ASANA_CLIENT_ID}",
      "oauthClientSecret": "${env:ASANA_CLIENT_SECRET}"
    }
  }
}
```

只有当 provider 无法完成动态客户端注册,或明确要求预注册 OAuth app 时,才使用这种配置。

### 远程 HTTP MCP,静态 Bearer Token

```json
{
  "mcpServers": {
    "internal": {
      "url": "https://mcp.example.com/mcp",
      "authType": "none",
      "headers": {
        "Authorization": "Bearer ${env:INTERNAL_MCP_TOKEN}"
      }
    }
  }
}
```

### Stdio MCP,邮箱服务商

```json
{
  "mcpServers": {
    "email": {
      "command": "npx",
      "args": ["@marlinjai/email-mcp"],
      "env": {
        "EMAIL_PROVIDER": "qq",
        "EMAIL_USER": "name@qq.com",
        "EMAIL_PASSWORD": "${env:QQ_MAIL_AUTH_CODE}",
        "SMTP_HOST": "smtp.qq.com",
        "SMTP_PORT": "465",
        "SMTP_SECURE": "true"
      }
    }
  }
}
```

邮箱授权码属于邮箱服务商的 app password,不是 MCP OAuth token。

## 实现文件

| 模块 | 文件 |
| --- | --- |
| 渲染进程设置 UI | `src/renderer/components/settings/McpConfigPanel.tsx` |
| 渲染进程桥接 | `src/preload/index.ts` |
| IPC 解析和清洗 | `src/main/ipc/mcp-handlers.ts` |
| 持久化配置和 session 存储 | `src/main/db/schema.ts`, `src/main/db/index.ts` |
| OAuth provider 适配器 | `src/main/mcp/oauth-provider.ts` |
| OAuth 全局设置解析 | `src/main/mcp/auth-settings.ts` |
| 结构化状态辅助 | `src/main/mcp/status.ts` |
| Transport、超时和 OAuth provider 挂载 | `src/main/mcp/client.ts` |
| 生命周期、状态和授权 callback | `src/main/mcp/manager.ts` |
| 工具暴露 | `src/main/mcp/tool-bridge.ts` |

## 测试

定向测试:

```bash
pnpm test \
  src/main/ipc/__tests__/mcp-handlers.test.ts \
  src/main/mcp/__tests__/auth-settings.test.ts \
  src/main/mcp/__tests__/client-auth.test.ts \
  src/main/mcp/__tests__/client-timeout.test.ts \
  src/main/mcp/__tests__/oauth-integration.test.ts \
  src/main/mcp/__tests__/oauth-provider.test.ts \
  src/main/mcp/__tests__/status.test.ts \
  src/renderer/i18n/__tests__/mcp-config-translations.test.ts
```

修改主进程或渲染进程 MCP 认证逻辑后,完整验证:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

手动冒烟测试:

1. 使用 `pnpm dev` 启动应用。
2. 添加一个 HTTP MCP server,只填写 URL,并保持 `Auth = Auto`。
3. 如果该 server 需要 OAuth,卡片应在 20s 内退出 loading,并显示可见的 `Authorize/授权` 按钮。
4. 点击 `Authorize/授权`;浏览器应打开。
5. 完成登录;callback 页面应提示该 server 已授权。
6. 回到应用;server 应自动重连并显示工具数量。
7. 点击 `Clear authorization/清除授权`;server 应清掉 token,然后重新显示需要授权的状态。
8. 打开 `OAuth 设置`,将 callback 端口和路径改为固定值;再次授权时浏览器中的 `redirect_uri` 应匹配配置值。

回归检查:

- 导入未声明 `auth/authType` 的 HTTP server 时,保存为 `authType: "auto"`。
- `authType: "none"` 永远不会创建 OAuth provider。
- OAuth client secret 不会返回给渲染进程。
- HTTP connect 挂住时会在配置的超时时间后 reject,并关闭 transport。
- Stdio server 始终把 auth 规范化为 `none`。
- 已保存的旧 OAuth session 仍可解密;新 session 在 `keychain/auto` 可用时使用钥匙串加密前缀。
- 本地 OAuth 集成测试必须覆盖 PRM 发现、PKCE 授权码、token 保存和 MCP 真实 SDK transport 重连。
