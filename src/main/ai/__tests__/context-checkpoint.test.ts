import { describe, expect, it } from "vitest";
import { applyContextCheckpoint } from "../context-checkpoint";
import type { HistoryMessage } from "../message-converter";

const history: HistoryMessage[] = [
  { id: "m1", role: "user", content: "pinned user" },
  { id: "m2", role: "assistant", content: "pinned assistant" },
  { id: "m3", role: "user", content: "covered old request" },
  { id: "m4", role: "assistant", content: "covered old answer" },
  { id: "m5", role: "user", content: "new request" },
];

describe("applyContextCheckpoint", () => {
  it("keeps pinned messages and only history after a valid watermark", () => {
    expect(
      applyContextCheckpoint(history, {
        coveredThroughMessageId: "m4",
        summary: "## 已完成\n- old work",
      }),
    ).toEqual({
      applied: true,
      history: [history[0], history[1], history[4]],
      summary: "## 已完成\n- old work",
    });
  });

  it("ignores a checkpoint whose watermark is absent", () => {
    expect(
      applyContextCheckpoint(history, {
        coveredThroughMessageId: "missing",
        summary: "stale summary",
      }),
    ).toEqual({ applied: false, history, summary: null });
  });
});
