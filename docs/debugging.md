# Debugging Guide

## Common Issues

**Build Failures:**
- Check TypeScript errors: `pnpm typecheck`
- Verify imports: Ensure proper relative/absolute paths
- Native dependencies: Run `pnpm postinstall`

**IPC Issues:**
- Verify handler registration in `main/index.ts`
- Check preload bridge definitions
- Ensure type definitions match actual handlers

**AI/Skill Issues:**
- Check skill registration in `skills/index.ts`
- Verify tool schemas match usage
- Review system prompts for clarity

**Database Issues:**
- Check schema definitions in `db/schema.ts`
- Verify migrations (auto-handled by Drizzle)
- Ensure proper type inference

## Development Tools

**Electron DevTools:**
- Main process: Use VS Code debugger or console logs
- Renderer: Use Chrome DevTools (Cmd+Opt+I)

**Database Inspection:**
- SQLite browser or similar tools
- Database location: `userData/filework.db`