/**
 * Shared credential kinds — single source of truth for both the main
 * process (db schema, IPC handlers, resolvers) and the renderer
 * (settings UI). The renderer can't import from `src/main/*` due to
 * the Vite/Electron build boundary, so the canonical union lives here.
 *
 * On adding a new credential kind:
 *   1. add the literal here,
 *   2. extend `credentials.kind` CHECK constraint in `src/main/db/index.ts`
 *      + the drizzle enum in `src/main/db/schema.ts`,
 *   3. add a row to `CREDENTIAL_KIND_OPTIONS` here so the settings UI picks it up,
 *   4. write a `<kind>CredentialResolver` if anything reads it on demand.
 */

export type CredentialKind =
  | "github_pat"
  | "gitlab_pat"
  | "tavily_pat"
  | "firecrawl_pat";

export interface CredentialKindOption {
  value: CredentialKind;
  label: string;
  placeholder: string;
}

export const CREDENTIAL_KIND_OPTIONS: readonly CredentialKindOption[] = [
  {
    value: "github_pat",
    label: "GitHub",
    placeholder: "ghp_… or github_pat_…",
  },
  { value: "gitlab_pat", label: "GitLab", placeholder: "glpat-…" },
  { value: "tavily_pat", label: "Tavily", placeholder: "tvly-…" },
  { value: "firecrawl_pat", label: "Firecrawl", placeholder: "fc-…" },
];

export const credentialKindLabel = (kind: CredentialKind): string =>
  CREDENTIAL_KIND_OPTIONS.find((o) => o.value === kind)?.label ?? kind;
