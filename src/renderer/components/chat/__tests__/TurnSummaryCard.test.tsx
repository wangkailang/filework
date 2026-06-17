import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TurnSummaryCard } from "../TurnSummaryCard";
import type { TurnSummaryPart } from "../types";

describe("TurnSummaryCard", () => {
  it("renders the collapsed delivery summary as secondary chat chrome", () => {
    const part: TurnSummaryPart = {
      type: "turn-summary",
      files: [
        {
          added: 3,
          op: "modify",
          path: "dragon-boat-poster.py",
          removed: 1,
          unknownStat: false,
          writeCount: 1,
        },
      ],
      commands: [
        {
          command: "python3 dragon-boat-poster.py",
          exitCode: 1,
          kind: "generic",
        },
      ],
    };

    const html = renderToStaticMarkup(<TurnSummaryCard part={part} />);

    expect(html).toContain("border-border/35");
    expect(html).toContain("bg-muted/10");
    expect(html).toContain("font-normal");
    expect(html).toContain("text-foreground/65");
    expect(html).not.toContain("bg-background/40");
    expect(html).not.toContain("font-medium");
  });
});
