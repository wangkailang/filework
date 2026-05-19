/**
 * Typed git tools — `proposeSessionBranch`, `gitCommit`, `gitPush`,
 * `openPullRequest`.
 *
 * Wraps the optional `WorkspaceSCM` surface (currently implemented by
 * GitHubWorkspace / GitLabWorkspace). Each destructive tool routes
 * through the `beforeToolCall` approval hook and is excluded from any
 * "approve once, auto-approve again" whitelist (see
 * `ai-tools.ts:ALWAYS_PROMPT_TOOLS`).
 *
 * Branch naming: the agent must call `proposeSessionBranch` once per
 * session to establish the working branch. Branch names follow Git
 * Flow conventions; when the agent isn't confident about scope, it
 * passes three candidates and the user picks one in the approval UI.
 *
 * Commit author: derived at runtime from the active LLM model via
 * `commitIdentity` on the workspace SCM deps (see `ai-handlers.ts`
 * for the wiring). The SCM `commit()` throws if identity is missing —
 * there is no hardcoded default.
 */

import { z } from "zod/v4";

import type { ToolApprovalRichPreview } from "../../session/message-parts";
import type { ToolContext, ToolDefinition } from "../tool-registry";

/** Tool name constant — referenced by the approval hook to apply the
 *  branch-choice argsOverride. Exported so callers don't hardcode the
 *  string in multiple files. */
export const PROPOSE_SESSION_BRANCH_TOOL = "proposeSessionBranch";

// ── Git Flow branch naming ──────────────────────────────────────────────

const GIT_FLOW_PREFIXES = [
  "feature",
  "bugfix",
  "hotfix",
  "release",
  "support",
  "chore",
  "docs",
] as const;

const GIT_FLOW_BRANCH_RE = new RegExp(
  `^(${GIT_FLOW_PREFIXES.join("|")})\\/[a-z0-9][a-z0-9._-]*$`,
);

const PROTECTED_BRANCHES = new Set(["main", "master", "develop", "release"]);

const MAX_BRANCH_LENGTH = 60;

const validateBranchName = (name: string): string | null => {
  if (name.length > MAX_BRANCH_LENGTH) {
    return `Branch name too long (${name.length} > ${MAX_BRANCH_LENGTH}): ${name}`;
  }
  if (PROTECTED_BRANCHES.has(name)) {
    return `Refusing to use protected branch as session branch: ${name}`;
  }
  if (!GIT_FLOW_BRANCH_RE.test(name)) {
    return `Branch name must follow Git Flow (${GIT_FLOW_PREFIXES.join("/, ")}/) with kebab-case scope: ${name}`;
  }
  return null;
};

// ── Rich preview shapes ──────────────────────────────────────────────────

/** Re-exported under the local name. Single source of truth lives in
 *  `core/session/message-parts.ts` so both renderer and main agree. */
export type RichPreview = ToolApprovalRichPreview;

// ── Tools ───────────────────────────────────────────────────────────────

const proposeSessionBranchSchema = z.object({
  candidates: z
    .array(z.string().min(1))
    .min(1)
    .max(3)
    .describe(
      "1 to 3 candidate branch names following Git Flow conventions " +
        "(feature/, bugfix/, hotfix/, release/, support/, chore/, docs/). " +
        "Pass 1 when confident; pass 3 when the user's intent is ambiguous.",
    ),
  rationale: z
    .string()
    .optional()
    .describe(
      "Short explanation surfaced to the user alongside the candidates.",
    ),
});

export const proposeSessionBranchTool: ToolDefinition<
  z.infer<typeof proposeSessionBranchSchema>,
  { branch: string }
> = {
  name: PROPOSE_SESSION_BRANCH_TOOL,
  description:
    "Propose the working branch for this session and let the user " +
    "approve it. Each candidate MUST follow Git Flow: one of feature/, " +
    "bugfix/, hotfix/, release/, support/, chore/, docs/ followed by " +
    "kebab-case scope (e.g. `feature/streaming-retries`). Pass exactly " +
    "1 candidate when you're confident; pass exactly 3 when the user's " +
    "intent is ambiguous (multiple plausible scopes) — the user picks. " +
    "Must be called before gitCommit. Call only once per session unless " +
    "the user explicitly asks to switch branches.",
  safety: "destructive",
  inputSchema: proposeSessionBranchSchema,
  previewBuilder: async (args): Promise<RichPreview> => ({
    kind: "branch-choice",
    candidates: args.candidates,
    rationale: args.rationale,
  }),
  execute: async (args, ctx) => {
    for (const c of args.candidates) {
      const err = validateBranchName(c);
      if (err) throw new Error(err);
    }
    const scm = ctx.workspace.scm;
    if (!scm?.setSessionBranch) {
      throw new Error(
        "Workspace does not support session branches (only GitHub / GitLab workspaces do).",
      );
    }
    if (scm.getSessionBranch?.() != null) {
      throw new Error(
        "Session branch already chosen for this session. Ask the user to confirm a switch, then call again with rationale.",
      );
    }
    // The approval hook resolves with a `choice` string; the IPC layer
    // overrides args.candidates[0] with the user-chosen value before
    // we reach here. We trust that and just persist it.
    const chosen = args.candidates[0];
    if (!chosen) {
      throw new Error("No candidate branch provided.");
    }
    const err = validateBranchName(chosen);
    if (err) throw new Error(err);
    scm.setSessionBranch(chosen);
    return { branch: chosen };
  },
};

const gitCommitSchema = z.object({
  message: z
    .string()
    .min(1, "commit message is required")
    .describe("Commit message (first line becomes the subject)"),
  files: z
    .array(z.string())
    .optional()
    .describe(
      "Workspace-relative paths to stage. Omit to stage all changes (`git add -A`).",
    ),
});

const buildCommitPreview = async (
  args: z.infer<typeof gitCommitSchema>,
  ctx: ToolContext,
): Promise<RichPreview> => {
  const scm = ctx.workspace.scm;
  const branch = scm?.getSessionBranch?.() ?? null;
  let files: string[] = [];
  if (args.files && args.files.length > 0) {
    files = args.files.slice(0, 20);
  } else if (scm?.diff) {
    try {
      const diff = await scm.diff();
      files = diff
        .split("\n")
        .filter((l) => l.startsWith("diff --git "))
        .map((l) => l.split(" b/")[1] ?? l)
        .slice(0, 20);
    } catch {
      // best-effort; preview proceeds without file list
    }
  }
  return {
    kind: "commit",
    branch,
    author: null,
    message: args.message.slice(0, 200),
    files,
  };
};

export const gitCommitTool: ToolDefinition<
  z.infer<typeof gitCommitSchema>,
  unknown
> = {
  name: "gitCommit",
  description:
    "Stage files and create a git commit on the session branch. You " +
    "MUST call `proposeSessionBranch` first if no branch is established " +
    "for this session — calling gitCommit before that will error. The " +
    "commit author is determined automatically from the active LLM " +
    "model; do not pass author info. Every call prompts the user for " +
    "approval individually (no batch / no whitelist), with a preview " +
    "showing branch, author, message, and the changed file list. " +
    "Returns {sha, branch, filesChanged}; sha is empty when there is " +
    "nothing to commit.",
  safety: "destructive",
  inputSchema: gitCommitSchema,
  previewBuilder: buildCommitPreview,
  execute: async (args, ctx) => {
    if (!ctx.workspace.scm?.commit) {
      throw new Error(
        "Workspace does not support gitCommit (only GitHub / GitLab workspaces do)",
      );
    }
    return ctx.workspace.scm.commit(args);
  },
};

const gitPushSchema = z.object({
  force: z
    .boolean()
    .optional()
    .describe("Use `--force-with-lease` (never raw `--force`). Default false."),
});

export const gitPushTool: ToolDefinition<
  z.infer<typeof gitPushSchema>,
  unknown
> = {
  name: "gitPush",
  description:
    "Push the session branch to origin. Sets upstream on first push. " +
    "Author / identity is inherited from the commits being pushed. " +
    "Requires user approval (always prompts — never auto-approved).",
  safety: "destructive",
  inputSchema: gitPushSchema,
  execute: async (args, ctx) => {
    if (!ctx.workspace.scm?.push) {
      throw new Error(
        "Workspace does not support gitPush (only GitHub / GitLab workspaces do)",
      );
    }
    return ctx.workspace.scm.push(args);
  },
};

const openPullRequestSchema = z.object({
  title: z
    .string()
    .min(1, "PR title is required")
    .describe("Short title shown in the PR list"),
  body: z
    .string()
    .optional()
    .describe("PR body in markdown. Defaults to empty."),
  draft: z.boolean().optional().describe("Open as a draft PR. Default false."),
  base: z
    .string()
    .optional()
    .describe(
      "Target branch on the remote. Defaults to the workspace ref the user opened.",
    ),
});

const buildPrPreview = async (
  args: z.infer<typeof openPullRequestSchema>,
  ctx: ToolContext,
): Promise<RichPreview> => {
  const scm = ctx.workspace.scm;
  const head = scm?.getSessionBranch?.() ?? null;
  return {
    kind: "pr",
    base: args.base ?? "(workspace default)",
    head,
    title: args.title,
    bodyPreview: (args.body ?? "").slice(0, 400),
    draft: args.draft ?? false,
  };
};

export const openPullRequestTool: ToolDefinition<
  z.infer<typeof openPullRequestSchema>,
  unknown
> = {
  name: "openPullRequest",
  description:
    "Open a pull request from the session branch to `base` (defaults " +
    "to the workspace ref). The session branch must already exist and " +
    "be pushed (call gitPush first). Returns {url, number}. Each call " +
    "prompts for approval individually with a full PR preview " +
    "(title, body, base, head, draft).",
  safety: "destructive",
  inputSchema: openPullRequestSchema,
  previewBuilder: buildPrPreview,
  execute: async (args, ctx) => {
    if (!ctx.workspace.scm?.openPullRequest) {
      throw new Error(
        "Workspace does not support openPullRequest (only GitHub / GitLab workspaces do)",
      );
    }
    return ctx.workspace.scm.openPullRequest(args);
  },
};

/** All git tools, in registration order. */
export const buildGitTools = (): ToolDefinition[] => [
  proposeSessionBranchTool as ToolDefinition,
  gitCommitTool as ToolDefinition,
  gitPushTool as ToolDefinition,
  openPullRequestTool as ToolDefinition,
];

// ── Test exports ────────────────────────────────────────────────────────

export const __test__ = {
  validateBranchName,
  GIT_FLOW_PREFIXES,
  PROTECTED_BRANCHES,
  MAX_BRANCH_LENGTH,
};
