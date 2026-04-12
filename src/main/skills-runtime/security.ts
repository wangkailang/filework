/**
 * Security module for AI Skills Runtime.
 *
 * Provides trust management, content hashing, environment filtering,
 * and command allow/block-listing for external SKILL.md skills.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { DiscoverySource, ParsedSkill, SkillTrustRecord } from "./types";

// ─── Command Prefixes ────────────────────────────────────────────────

/** Read-only commands considered safe for high/medium trust skills. */
export const SAFE_COMMAND_PREFIXES: readonly string[] = [
  "cat",
  "ls",
  "echo",
  "head",
  "tail",
  "wc",
  "git log",
  "git status",
  "git diff",
  "git branch",
  "node --version",
  "npm --version",
  "python --version",
];

/** Dangerous commands that are always blocked regardless of trust level. */
export const BLOCKED_COMMAND_PREFIXES: readonly string[] = [
  "curl",
  "wget",
  "nc",
  "ssh",
  "scp",
  "rm",
  "sudo",
  "chmod",
  "chown",
  "open",
  "osascript",
  "pbcopy",
];

// ─── Sensitive Env Var Patterns ──────────────────────────────────────

/** Regex patterns for environment variable names that should be filtered out. */
const SENSITIVE_ENV_PATTERNS = [
  /_API_KEY$/i,
  /_SECRET$/i,
  /_TOKEN$/i,
  /_PASSWORD$/i,
];

/** Explicit list of sensitive env vars to always filter. */
const SENSITIVE_ENV_EXPLICIT = new Set([
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "DEEPSEEK_API_KEY",
]);

/** Basic env vars that are always kept in the safe environment. */
const SAFE_ENV_VARS = new Set([
  "PATH",
  "HOME",
  "LANG",
  "SHELL",
  "USER",
  "TERM",
]);

// ─── Trust Store (in-memory) ─────────────────────────────────────────

/** In-memory map of skill trust records, keyed by skillId. */
const trustStore = new Map<string, SkillTrustRecord>();

// ─── Trust Level ─────────────────────────────────────────────────────

/** Trust level derived from a skill's discovery source. */
export type TrustLevel = "high" | "medium" | "low";

/**
 * Map a {@link DiscoverySource} type to a trust level.
 *
 * - `project` (.agents/skills/) → high
 * - `personal` (~/.agents/skills/) → medium
 * - `additional` → low
 */
export function getTrustLevel(sourceType: DiscoverySource["type"]): TrustLevel {
  switch (sourceType) {
    case "project":
      return "high";
    case "personal":
      return "medium";
    case "additional":
      return "low";
  }
}

// ─── Core Functions ──────────────────────────────────────────────────

/**
 * Compute a SHA-256 hash of a skill's content (SKILL.md + hook scripts).
 *
 * Reads the SKILL.md file and, if hooks are defined in the frontmatter,
 * also reads the hook script files. All content is concatenated and
 * hashed to produce a hex digest.
 *
 * @param skillDir - Absolute path to the skill directory containing SKILL.md
 */
export async function computeSkillHash(skillDir: string): Promise<string> {
  const parts: string[] = [];

  // Always read SKILL.md
  const skillMdPath = join(skillDir, "SKILL.md");
  const skillContent = await readFile(skillMdPath, "utf-8");
  parts.push(skillContent);

  // Attempt to read hook scripts if they exist alongside SKILL.md
  // We parse the SKILL.md to find hook paths, but to avoid circular deps
  // we do a lightweight scan for hooks in the frontmatter
  const { parseSkillMd } = await import("./parser");
  try {
    const parsed = parseSkillMd(skillContent, skillMdPath);
    const hooks = parsed.frontmatter.hooks;
    if (hooks) {
      for (const hookPath of [hooks["pre-activate"], hooks["post-complete"]]) {
        if (hookPath) {
          try {
            const resolvedPath = join(skillDir, hookPath);
            const hookContent = await readFile(resolvedPath, "utf-8");
            parts.push(hookContent);
          } catch {
            // Hook file doesn't exist or can't be read — skip it
          }
        }
      }
    }
  } catch {
    // If parsing fails, just hash the raw SKILL.md content
  }

  const hash = createHash("sha256");
  hash.update(parts.join(""));
  return hash.digest("hex");
}

/**
 * Check whether a skill is currently trusted.
 *
 * A skill is trusted only when:
 * 1. A trust record exists for the given skillId
 * 2. The record is marked as approved
 * 3. The stored content hash matches the current hash
 *
 * @param skillId - The skill's unique identifier
 * @param currentHash - The freshly computed content hash
 */
export function isSkillTrusted(skillId: string, currentHash: string): boolean {
  const record = trustStore.get(skillId);
  if (!record) {
    return false;
  }
  return record.approved && record.contentHash === currentHash;
}

/**
 * Request user approval for a skill via IPC.
 *
 * Sends an approval request to the renderer process and waits for the
 * user's response. On approval, stores the trust record in the
 * in-memory trust store.
 *
 * This is a placeholder that will be fully connected to IPC later.
 * Currently uses `sender.send('skill:approval-request', ...)` pattern.
 *
 * @param sender - The Electron WebContents to send the IPC message to
 * @param skill - The parsed skill requesting approval
 * @param commands - List of !command strings found in the skill
 * @param hooks - List of hook script paths found in the skill
 */
export async function requestSkillApproval(
  sender: Electron.WebContents,
  skill: ParsedSkill,
  commands: string[],
  hooks: string[],
): Promise<SkillTrustRecord> {
  const skillId = skill.frontmatter.name || "";
  const skillDir = join(skill.sourcePath, "..");

  // Compute the current content hash
  let contentHash: string;
  try {
    contentHash = await computeSkillHash(skillDir);
  } catch {
    contentHash = "";
  }

  // Send approval request to renderer
  sender.send("skill:approval-request", {
    skillId,
    sourcePath: skill.sourcePath,
    commands,
    hooks,
  });

  // Create the trust record (placeholder — in a real implementation
  // this would await the user's IPC response)
  const record: SkillTrustRecord = {
    skillId,
    sourcePath: skill.sourcePath,
    contentHash,
    approved: true,
    approvedAt: new Date().toISOString(),
    permissions: {
      allowCommands: commands.length > 0,
      allowHooks: hooks.length > 0,
    },
  };

  // Store in the in-memory trust map
  trustStore.set(skillId, record);

  return record;
}

/**
 * Build a safe environment variable map for !command execution.
 *
 * Filters out sensitive variables matching patterns like `*_API_KEY`,
 * `*_SECRET`, `*_TOKEN`, `*_PASSWORD`, as well as an explicit blocklist.
 * Only keeps basic system variables (PATH, HOME, LANG, SHELL, USER, TERM)
 * and any non-sensitive variables.
 */
export function buildSafeEnv(): Record<string, string> {
  const safeEnv: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) {
      continue;
    }

    // Always keep safe system vars
    if (SAFE_ENV_VARS.has(key)) {
      safeEnv[key] = value;
      continue;
    }

    // Filter explicit sensitive vars
    if (SENSITIVE_ENV_EXPLICIT.has(key)) {
      continue;
    }

    // Filter pattern-matched sensitive vars
    if (SENSITIVE_ENV_PATTERNS.some((pattern) => pattern.test(key))) {
      continue;
    }

    // Keep everything else
    safeEnv[key] = value;
  }

  return safeEnv;
}

/**
 * Check whether a command is allowed to execute given the trust level.
 *
 * Rules:
 * - Blocked commands always return `false` regardless of trust level
 * - Low trust: all commands are blocked (return `false`)
 * - Safe commands return `true` for high/medium trust
 * - Unknown commands (not in safe or blocked list):
 *   - `high` trust → `true`
 *   - `medium` / `low` trust → `false`
 *
 * @param command - The shell command string to check
 * @param trustLevel - The trust level of the skill's source
 */
export function isCommandAllowed(
  command: string,
  trustLevel: TrustLevel,
): boolean {
  const trimmed = command.trim();

  // Blocked commands are always rejected
  if (BLOCKED_COMMAND_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) {
    return false;
  }

  // Low trust: everything is blocked
  if (trustLevel === "low") {
    return false;
  }

  // Safe commands are allowed for high/medium
  if (SAFE_COMMAND_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) {
    return true;
  }

  // Unknown commands: only allowed for high trust
  return trustLevel === "high";
}

// ─── Test Helpers ────────────────────────────────────────────────────

/**
 * Clear the in-memory trust store. Exposed for testing purposes only.
 * @internal
 */
export function _clearTrustStore(): void {
  trustStore.clear();
}

/**
 * Set a trust record directly. Exposed for testing purposes only.
 * @internal
 */
export function _setTrustRecord(
  skillId: string,
  record: SkillTrustRecord,
): void {
  trustStore.set(skillId, record);
}
