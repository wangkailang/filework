import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findDuplicates } from "../../native";

describe("findDuplicates (native)", () => {
  it("groups identical files and reports wasted bytes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fw-dedup-"));
    writeFileSync(join(dir, "a.bin"), "DUPLICATE");
    writeFileSync(join(dir, "b.bin"), "DUPLICATE");
    writeFileSync(join(dir, "c.bin"), "unique-content");

    const result = await findDuplicates(dir);

    expect(result.duplicateGroups).toBe(1);
    expect(result.groups[0]).toHaveLength(2);
    expect(result.totalWastedBytes).toBe("DUPLICATE".length);
    expect(result.scanned).toBe(3);
    expect(typeof result.skipped).toBe("number");
  });

  it("filters by extension", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fw-dedup-ext-"));
    writeFileSync(join(dir, "x.jpg"), "SAME");
    writeFileSync(join(dir, "y.jpg"), "SAME");
    writeFileSync(join(dir, "z.txt"), "SAME");

    const result = await findDuplicates(dir, [".jpg"]);
    expect(result.scanned).toBe(2);
    expect(result.duplicateGroups).toBe(1);
  });
});
