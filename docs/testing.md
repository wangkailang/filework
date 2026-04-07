# Testing Guidelines

## Test Structure

```
src/main/
├── skills/__tests__/           # Skill unit tests
├── skills-runtime/__tests__/   # Runtime engine tests
├── ai/__tests__/              # AI utilities tests
└── db/__tests__/              # Database tests
```

## Testing Patterns

**Unit Tests (Vitest):**
```typescript
import { describe, it, expect } from "vitest";
import { myFunction } from "../my-module";

describe("myFunction", () => {
  it("should process data correctly", () => {
    const result = myFunction("input");
    expect(result).toEqual("expected");
  });
});
```

**Property-Based Tests (fast-check):**
```typescript
import fc from "fast-check";

it("should handle arbitrary inputs", () => {
  fc.assert(
    fc.property(fc.string(), (input) => {
      const result = processString(input);
      expect(result).toBeDefined();
    })
  );
});
```

## Development Tools

**Electron DevTools:**
- Main process: Use VS Code debugger or console logs
- Renderer: Use Chrome DevTools (Cmd+Opt+I)