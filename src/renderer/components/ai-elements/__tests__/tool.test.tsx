import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from "../tool";

vi.mock("../../../i18n/i18n-react", () => ({
  useI18nContext: () => ({
    LL: {
      tool_done: () => "Done",
      tool_error: () => "Error",
      tool_errorLabel: () => "Error",
      tool_params: () => "Parameters",
      tool_preparing: () => "Preparing",
      tool_result: () => "Result",
      tool_running: () => "Running",
      toolName_automationUpdate: () => "Manage automations",
      toolName_createDirectory: () => "Create directory",
      toolName_deleteFile: () => "Delete file",
      toolName_directoryStats: () => "Directory stats",
      toolName_findDuplicates: () => "Find duplicates",
      toolName_listDirectory: () => "List directory",
      toolName_moveFile: () => "Move file",
      toolName_readFile: () => "Read file",
      toolName_runCommand: () => "Run command",
      toolName_runProcess: () => "Run process",
      toolName_searchFiles: () => "Search files",
      toolName_spawnSubagent: () => "Spawn subagent",
      toolName_webFetch: () => "Fetch",
      toolName_webFetchRendered: () => "Fetch rendered",
      toolName_webScrape: () => "Scrape",
      toolName_webSearch: () => "Web search",
      toolName_writeFile: () => "Write file",
      toolName_youtubeTranscript: () => "YouTube transcript",
    },
  }),
}));

describe("Tool chrome", () => {
  it("renders expanded tool details as secondary chat chrome", () => {
    const html = renderToStaticMarkup(
      <Tool defaultOpen>
        <ToolHeader
          state="output-available"
          summary={<span>src/index.ts</span>}
          toolName="writeFile"
        />
        <ToolContent>
          <ToolInput input={{ path: "src/index.ts" }} />
          <ToolOutput output="ok" />
        </ToolContent>
      </Tool>,
    );

    expect(html).toContain("border-border/45");
    expect(html).toContain("bg-muted/10");
    expect(html).toContain("hover:bg-muted/25");
    expect(html).toContain("border-border/35");
    expect(html).not.toContain("border-border-strong");
    expect(html).not.toContain("bg-card");
    expect(html).not.toContain("hover:bg-muted/50");
  });

  it("tones down status and error output colors", () => {
    const html = renderToStaticMarkup(
      <Tool defaultOpen>
        <ToolHeader state="output-error" toolName="runCommand" />
        <ToolContent>
          <ToolOutput errorText="boom" />
        </ToolContent>
      </Tool>,
    );

    expect(html).toContain("text-status-error/70");
    expect(html).toContain("font-normal");
    expect(html).toContain("text-status-error/80");
    expect(html).not.toContain("text-status-error whitespace-pre-wrap");
  });

  it("localizes the automation update tool name", () => {
    const html = renderToStaticMarkup(
      <Tool defaultOpen>
        <ToolHeader state="output-available" toolName="automation_update" />
      </Tool>,
    );

    expect(html).toContain("Manage automations");
    expect(html).not.toContain("automation_update");
  });

  it("localizes the search files tool name", () => {
    const html = renderToStaticMarkup(
      <Tool defaultOpen>
        <ToolHeader state="output-available" toolName="searchFiles" />
      </Tool>,
    );

    expect(html).toContain("Search files");
    expect(html).not.toContain(">searchFiles<");
  });

  it("renders distinct leading icons for different tools", () => {
    const readHtml = renderToStaticMarkup(
      <Tool>
        <ToolHeader state="output-available" toolName="readFile" />
      </Tool>,
    );
    const searchHtml = renderToStaticMarkup(
      <Tool>
        <ToolHeader state="output-available" toolName="webSearch" />
      </Tool>,
    );

    expect(readHtml).toContain('data-tool-icon="file-text"');
    expect(searchHtml).toContain('data-tool-icon="search"');
    expect(readHtml).not.toContain('data-tool-icon="search"');
    expect(searchHtml).not.toContain('data-tool-icon="file-text"');
  });

  it("places the expand chevron after the tool summary", () => {
    const html = renderToStaticMarkup(
      <Tool>
        <ToolHeader
          state="output-available"
          summary={<span>src/index.ts</span>}
          toolName="readFile"
        />
      </Tool>,
    );

    const toolIconIndex = html.indexOf('data-tool-icon="file-text"');
    const labelIndex = html.indexOf("Read file");
    const summaryIndex = html.indexOf("src/index.ts");
    const chevronIndex = html.indexOf("lucide-chevron-right");

    expect(toolIconIndex).toBeGreaterThan(-1);
    expect(labelIndex).toBeGreaterThan(toolIconIndex);
    expect(summaryIndex).toBeGreaterThan(labelIndex);
    expect(chevronIndex).toBeGreaterThan(summaryIndex);
  });
});
