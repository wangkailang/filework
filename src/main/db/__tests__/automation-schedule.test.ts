import { describe, expect, it } from "vitest";

import {
  computeAutomationNextRunAt,
  previewAutomationSchedule,
} from "../index";

describe("automation schedule calculation", () => {
  it("computes the next run for five-field cron schedules", () => {
    const next = computeAutomationNextRunAt(
      "cron",
      "*/15 * * * *",
      new Date(2026, 5, 18, 9, 7, 30),
    );

    expect(next).toBe(new Date(2026, 5, 18, 9, 15).toISOString());
  });

  it("computes the next weekly cron run", () => {
    const next = computeAutomationNextRunAt(
      "cron",
      "0 9 * * 1",
      new Date(2026, 5, 19, 10),
    );

    expect(next).toBe(new Date(2026, 5, 22, 9).toISOString());
  });

  it("throws for invalid interval schedules", () => {
    expect(() =>
      computeAutomationNextRunAt("interval", "soon", new Date(2026, 5, 18, 9)),
    ).toThrow(/interval/i);
  });

  it("previews the next run and the display timezone", () => {
    const preview = previewAutomationSchedule(
      "daily",
      "09:00",
      new Date(2026, 5, 18, 8, 30),
      "Asia/Shanghai",
    );

    expect(preview).toEqual({
      nextRunAt: new Date(2026, 5, 18, 9).toISOString(),
      timeZone: "Asia/Shanghai",
    });
  });

  it("fails schedule previews when the next run cannot be computed", () => {
    expect(() =>
      previewAutomationSchedule("weekly", "someday 09:00", new Date()),
    ).toThrow(/schedule/i);
  });
});
