# Common Workflows

## Adding a New Skill

1. **Create skill file**: `src/main/skills/my-skill.ts`
2. **Define skill interface**: Follow `Skill` type pattern
3. **Implement tools**: Define tools with Zod schemas
4. **Register skill**: Add to `src/main/skills/index.ts`
5. **Test skill**: Create tests in `__tests__/`
6. **Update documentation**: Add to skills table above

## Adding IPC Handler

1. **Create handler file**: `src/main/ipc/feature-handlers.ts`
2. **Define handlers**: Use `ipcMain.handle` pattern
3. **Register handlers**: Call register function in `main/index.ts`
4. **Type definitions**: Add to `src/renderer/types/global.d.ts`
5. **Frontend usage**: Call via `window.api.feature.action()`

## 修改 MCP 认证

1. **更新解析**: 保持 `src/main/ipc/mcp-handlers.ts` 和导入 JSON 格式一致
2. **更新存储**: 在 `src/main/db/index.ts` 添加迁移,在 `src/main/db/schema.ts` 更新 schema
3. **更新生命周期**: 在 `src/main/mcp/manager.ts` 维护 OAuth 状态流转
4. **更新传输行为**: 在 `src/main/mcp/client.ts` 处理 provider 挂载、超时和重连行为
5. **更新 UI**: 在 `src/renderer/components/settings/McpConfigPanel.tsx` 保持授权操作显式可见
6. **验证**: 按 [MCP 认证](./mcp-authentication.md#测试) 执行

## Modifying AI Behavior

1. **Skill-specific**: Edit `systemPrompt` in skill definition
2. **Global behavior**: Modify prompts in `ai-handlers.ts`
3. **Tool permissions**: Update `ai-tool-permissions.ts`
4. **New tools**: Add to `ai-tools.ts` with proper schemas

## UI Component Development

1. **Check design tokens**: Review `global.css` variables
2. **Create component**: In appropriate `components/` subdirectory
3. **Use type-safe props**: Define interfaces with proper typing
4. **Follow naming**: PascalCase for components, camelCase for utilities
5. **Export properly**: Add to relevant index files
