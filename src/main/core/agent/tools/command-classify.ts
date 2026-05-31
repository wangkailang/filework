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

// Command heads that change the filesystem — the bounded set of things that
// actually constitute a deliverable. We allowlist these (rather than denylist
// read-only commands, an unbounded set: pipes, `while` loops, `$(...)`, awk,
// arbitrary scripts) so the card fails toward hiding noise, not surfacing it.
const MUTATING_HEADS = new Set([
  // file ops
  "mv",
  "cp",
  "rm",
  "rmdir",
  "mkdir",
  "touch",
  "ln",
  "link",
  "install",
  "dd",
  "truncate",
  "rsync",
  "trash",
  "srm",
  "mktemp",
  "mkfile",
  "mkfifo",
  "tee",
  // archive / compression
  "zip",
  "unzip",
  "tar",
  "gzip",
  "gunzip",
  "bzip2",
  "bunzip2",
  "xz",
  "unxz",
  "zstd",
  "7z",
  "compress",
  "rar",
  "unrar",
  // permissions / attributes
  "chmod",
  "chown",
  "chgrp",
  "chflags",
  "xattr",
  // media / document conversion (common filework deliverables)
  "sips",
  "convert",
  "magick",
  "ffmpeg",
  "pandoc",
  "qpdf",
  "gs",
]);

// Inline-script interpreters: a deliverable only if the snippet shows a
// filesystem write (see MUTATION_MARKERS); a pure "compute disk usage" script
// has none and stays out of the card.
const INTERPRETERS = new Set([
  "python",
  "python3",
  "node",
  "ruby",
  "perl",
  "bash",
  "sh",
  "zsh",
]);

// git subcommands that change repo/working-tree state.
const MUTATING_GIT = new Set([
  "add",
  "commit",
  "mv",
  "rm",
  "checkout",
  "switch",
  "reset",
  "restore",
  "stash",
  "apply",
  "clean",
  "merge",
  "rebase",
  "cherry-pick",
  "revert",
  "init",
  "clone",
  "pull",
  "push",
  "tag",
]);

// Substrings inside an interpreter snippet that imply it writes to the
// filesystem or shells out — the snippet then counts as a deliverable.
const MUTATION_MARKERS = [
  "remove",
  "rmdir",
  "rmtree",
  "unlink",
  "makedirs",
  "mkdir",
  "rename",
  "shutil",
  "subprocess",
  "os.system",
  "popen",
  "chmod",
  "chown",
  "truncate",
  "'w'",
  '"w"',
  "'wb'",
  '"wb"',
  "'a'",
  "'a+'",
  "mode='w'",
  'mode="w"',
];

function stripEnvAssignments(tokens: string[]): string[] {
  let i = 0;
  while (i < tokens.length && /^\w+=/.test(tokens[i])) i++;
  return tokens.slice(i);
}

/**
 * Split a command line into segments on the shell operators `&&`, `||`, `;`,
 * `|`, and newlines, but only when they appear OUTSIDE quotes. A naive
 * `.split()` would wrongly break `python3 -c "import os; print(...)"` at the
 * in-string `;`. Pipes inside quotes (e.g. a grep pattern) stay intact too.
 */
function splitSegments(command: string): string[] {
  const segments: string[] = [];
  let buf = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      buf += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
      continue;
    }
    const two = command.slice(i, i + 2);
    if (two === "&&" || two === "||") {
      segments.push(buf);
      buf = "";
      i++; // consume the second operator char
      continue;
    }
    if (ch === ";" || ch === "|" || ch === "\n") {
      segments.push(buf);
      buf = "";
      continue;
    }
    buf += ch;
  }
  segments.push(buf);
  return segments.map((s) => s.trim()).filter(Boolean);
}

/**
 * True when a segment writes to a real file via `>` / `>>` redirection.
 * Ignores fd-dups (`2>&1`, `>&2`) and `/dev/null`, which deliver nothing.
 */
function hasWriteRedirect(segment: string): boolean {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ">") {
      if (segment[i + 1] === "&") continue; // fd-dup, not a file write
      const target = segment
        .slice(i + 1)
        .replace(/^>?\s*/, "")
        .split(/\s/)[0];
      if (target && target !== "/dev/null" && !target.startsWith("&")) {
        return true;
      }
    }
  }
  return false;
}

function segmentIsDeliverable(segment: string): boolean {
  if (hasWriteRedirect(segment)) return true;
  const tokens = stripEnvAssignments(segment.split(/\s+/).filter(Boolean));
  if (tokens.length === 0) return false;
  const head = tokens[0].replace(/^.*\//, ""); // strip any leading path
  if (MUTATING_HEADS.has(head)) return true;
  if (head === "git") return tokens.length > 1 && MUTATING_GIT.has(tokens[1]);
  if (head === "sed") return tokens.some((t) => t.startsWith("-i")); // in-place
  if (INTERPRETERS.has(head)) {
    const lower = segment.toLowerCase();
    return MUTATION_MARKERS.some((m) => lower.includes(m));
  }
  return false;
}

/**
 * True when a `runCommand` invocation changed the filesystem — any segment of
 * the chain runs a known file-mutating command (or writes via redirect). Used
 * to keep only genuine deliverables in the turn card; read-only inspections
 * (`du`, `find | while ... stat`, compute scripts) return false and are hidden.
 * Conservative the other way: an unrecognized mutator is under-reported, never
 * shown as noise.
 */
export function isDeliverableCommand(command: string): boolean {
  return splitSegments(command).some(segmentIsDeliverable);
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
