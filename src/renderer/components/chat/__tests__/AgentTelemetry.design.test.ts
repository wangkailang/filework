import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const telemetrySource = readFileSync(
  resolve(__dirname, "../AgentTelemetry.tsx"),
  "utf8",
);

describe("AgentTelemetry design", () => {
  it("uses restrained neutral styling instead of decorative scan effects", () => {
    expect(telemetrySource).toContain("bg-surface");
    expect(telemetrySource).toContain("border-b border-border-faint");
    expect(telemetrySource).not.toContain("bg-gradient-to-b");
    expect(telemetrySource).not.toContain("animate-scan");
    expect(telemetrySource).not.toContain("bg-gradient-to-r");
  });
});
