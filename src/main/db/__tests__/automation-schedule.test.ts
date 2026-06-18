import { describe, expect, it } from "vitest";

import { computeAutomationNextRunAt } from "../index";

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
});
