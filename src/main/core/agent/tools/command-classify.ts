/**
 * Backend-side classification of a `runCommand` invocation, so the turn
 * summary (and any other consumer) reads facts off the tool result rather
 * than re-parsing stdout in the renderer. Pure string-in / data-out — no
 * IO, no side effects.
 */

export type CommandKind = "test" | "build" | "generic";

// Test-runner signatures. Checked before build so a command that both
// builds and tests (e.g. `npm run build && npm test`) is reported as a
// test run — that's the stronger signal about what the user cares about.
const TEST_PATTERNS: RegExp[] = [
  /\b(?:vitest|jest|mocha|ava|rspec|phpunit|cypress)\b/,
  /\bpytest\b/,
  /\b(?:go|cargo|deno|dotnet)\s+test\b/,
  /\bplaywright\s+test\b/,
  /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b/,
];

const BUILD_PATTERNS: RegExp[] = [
  /\btsc\b/,
  /\b(?:go|cargo)\s+build\b/,
  /\bvite\s+build\b/,
  /\b(?:webpack|rollup|esbuild|gulp|grunt)\b/,
  /\b(?:make|cmake|gradle|mvn)\b/,
  /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?build\b/,
];

export function classifyCommand(command: string): CommandKind {
  const c = command.toLowerCase();
  if (TEST_PATTERNS.some((re) => re.test(c))) return "test";
  if (BUILD_PATTERNS.some((re) => re.test(c))) return "build";
  return "generic";
}

/**
 * Pull `{ passed, failed }` out of a test runner's output. Tolerant of the
 * common formats (jest / vitest / pytest) by simply taking the first
 * `N passed` and `N failed` counts anywhere in the combined output — these
 * runners all print a summary line with those tokens. Returns undefined
 * when neither token is present (e.g. go test, or a non-test command), so
 * the caller can omit `testStats` entirely.
 */
export function parseTestStats(
  stdout: string,
  stderr: string,
): { passed: number; failed: number } | undefined {
  const text = `${stdout}\n${stderr}`;
  const passedMatch = text.match(/(\d+)\s+passed/i);
  const failedMatch = text.match(/(\d+)\s+failed/i);
  if (!passedMatch && !failedMatch) return undefined;
  return {
    passed: passedMatch ? Number.parseInt(passedMatch[1], 10) : 0,
    failed: failedMatch ? Number.parseInt(failedMatch[1], 10) : 0,
  };
}
