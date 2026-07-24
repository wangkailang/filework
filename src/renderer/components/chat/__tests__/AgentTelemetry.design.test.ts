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

  it("keeps collapsed rail telemetry labels visually centered", () => {
    expect(telemetrySource).toContain("h-[34px]");
    expect(telemetrySource).toContain('reserveLeft ? "pl-16" : "pl-3.5"');
    expect(telemetrySource).toContain("uppercase leading-none");
  });

  it("keeps persistent status text at the shared 12px minimum", () => {
    expect(telemetrySource).toContain("text-xs");
    expect(telemetrySource).not.toContain("text-[11px]");
  });
});
