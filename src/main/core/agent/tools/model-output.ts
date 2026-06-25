import type { ToolResultOutput } from "@ai-sdk/provider-utils";

const DEFAULT_TEXT_BUDGET = 12_000;
const RESULT_SNIPPET_BUDGET = 600;
const WEB_SEARCH_RESULT_LIMIT = 8;
const WEB_SEARCH_IMAGE_LIMIT = 5;

export const textModelOutput = (value: string): ToolResultOutput => ({
  type: "text",
  value,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object";

const asString = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const countArray = (value: unknown): number =>
  Array.isArray(value) ? value.length : 0;

export const clipForModel = (
  value: string,
  budget = DEFAULT_TEXT_BUDGET,
): string => {
  if (value.length <= budget) return value;
  const omitted = value.length - budget;
  return `${value.slice(0, budget)}\n...[truncated ${omitted} chars for model context; full raw tool output is available in UI/trace]`;
};

const compactJson = (
  value: unknown,
  budget = RESULT_SNIPPET_BUDGET,
): string => {
  try {
    return clipForModel(JSON.stringify(value), budget);
  } catch {
    return String(value);
  }
};

export const projectReadFileModelOutput = ({
  input,
  output,
}: {
  input: { path?: string };
  output: string;
}): ToolResultOutput =>
  textModelOutput(
    [
      `readFile ${input.path ?? "(unknown path)"}`,
      `Characters: ${output.length}`,
      output.length > DEFAULT_TEXT_BUDGET ? "Truncated for model: true" : null,
      "Content:",
      clipForModel(output),
    ]
      .filter(Boolean)
      .join("\n"),
  );

export const projectCommandModelOutput = ({
  input,
  output,
  label = "runCommand",
}: {
  input: { command?: string; shellId?: string };
  output: unknown;
  label?: string;
}): ToolResultOutput => {
  if (!isRecord(output)) {
    return textModelOutput(
      [
        `${label} ${input.command ?? input.shellId ?? ""}`.trim(),
        "Output:",
        clipForModel(String(output)),
      ].join("\n"),
    );
  }

  const stdout = asString(output.stdout);
  const stderr = asString(output.stderr);
  const lines = [
    `${label} ${input.command ?? input.shellId ?? ""}`.trim(),
    output.exitCode !== undefined
      ? `Exit code: ${String(output.exitCode)}`
      : null,
    output.success !== undefined ? `Success: ${String(output.success)}` : null,
    asString(output.commandKind)
      ? `Command kind: ${asString(output.commandKind)}`
      : null,
    output.deliverable !== undefined
      ? `Deliverable: ${String(output.deliverable)}`
      : null,
    output.testStats !== undefined
      ? `Test stats: ${compactJson(output.testStats, 1_000)}`
      : null,
    asString(output.hint) ? `Hint: ${asString(output.hint)}` : null,
    stdout ? `Stdout:\n${clipForModel(stdout, 8_000)}` : null,
    stderr ? `Stderr:\n${clipForModel(stderr, 6_000)}` : null,
    !stdout && !stderr ? `Output: ${compactJson(output, 4_000)}` : null,
  ];
  return textModelOutput(lines.filter(Boolean).join("\n"));
};

export const projectWebFetchModelOutput = ({
  input,
  output,
  toolName,
}: {
  input: { url?: string };
  output: unknown;
  toolName: "webFetch" | "webFetchRendered" | "webScrape";
}): ToolResultOutput => {
  if (!isRecord(output)) {
    return textModelOutput(`${toolName} ${input.url ?? ""}\n${String(output)}`);
  }

  const url = asString(output.url) ?? input.url ?? "(unknown url)";
  const status =
    output.status !== undefined
      ? `Status: ${String(output.status)} ${asString(output.statusText) ?? ""}`.trim()
      : null;
  const markdown = asString(output.markdown);
  const raw = asString(output.raw);
  const error = asString(output.error);
  const content = markdown ?? raw ?? error ?? "";

  const lines = [
    `${toolName} ${url}`,
    status,
    asString(output.contentType)
      ? `Content-Type: ${asString(output.contentType)}`
      : null,
    asString(output.title) ? `Title: ${asString(output.title)}` : null,
    asString(output.excerpt) ? `Excerpt: ${asString(output.excerpt)}` : null,
    output.pages !== undefined ? `Pages: ${String(output.pages)}` : null,
    Array.isArray(output.matchedPages)
      ? `Matched pages: ${output.matchedPages.join(", ")}`
      : null,
    Array.isArray(output.matchedChunks)
      ? `Matched chunks: ${output.matchedChunks.length}`
      : null,
    `Images: ${countArray(output.images)}`,
    `Videos: ${countArray(output.videos)}`,
    output.truncated !== undefined
      ? `Truncated: ${String(output.truncated)}`
      : null,
    error && !markdown && !raw ? `Error: ${error}` : null,
    content ? `Content:\n${clipForModel(content)}` : null,
  ];

  return textModelOutput(lines.filter(Boolean).join("\n"));
};

export const projectWebSearchModelOutput = ({
  input,
  output,
}: {
  input: { query?: string };
  output: unknown;
}): ToolResultOutput => {
  if (!isRecord(output)) {
    return textModelOutput(`webSearch ${input.query ?? ""}\n${String(output)}`);
  }

  const results = Array.isArray(output.results) ? output.results : [];
  const images = Array.isArray(output.images) ? output.images : [];
  const lines = [
    `webSearch ${input.query ?? ""}`.trim(),
    asString(output.answer) ? `Answer: ${asString(output.answer)}` : null,
    `Results: ${results.length}`,
  ];

  for (const [idx, item] of results
    .slice(0, WEB_SEARCH_RESULT_LIMIT)
    .entries()) {
    if (!isRecord(item)) continue;
    const title = asString(item.title) ?? "(untitled)";
    const url = asString(item.url) ?? "";
    const snippet = asString(item.snippet);
    lines.push(
      `${idx + 1}. ${title}${url ? `\nURL: ${url}` : ""}${
        snippet
          ? `\nSnippet: ${clipForModel(snippet, RESULT_SNIPPET_BUDGET)}`
          : ""
      }`,
    );
  }

  if (results.length > WEB_SEARCH_RESULT_LIMIT) {
    lines.push(
      `Additional results omitted: ${results.length - WEB_SEARCH_RESULT_LIMIT}`,
    );
  }

  lines.push(`Images: ${images.length}`);
  for (const [idx, item] of images.slice(0, WEB_SEARCH_IMAGE_LIMIT).entries()) {
    if (!isRecord(item)) continue;
    const url = asString(item.url);
    const description = asString(item.description);
    if (!url) continue;
    lines.push(
      `Image ${idx + 1}: ${url}${
        description
          ? `\nDescription: ${clipForModel(description, RESULT_SNIPPET_BUDGET)}`
          : ""
      }`,
    );
  }
  if (images.length > WEB_SEARCH_IMAGE_LIMIT) {
    lines.push(
      `Additional images omitted: ${images.length - WEB_SEARCH_IMAGE_LIMIT}`,
    );
  }

  return textModelOutput(lines.filter(Boolean).join("\n"));
};
