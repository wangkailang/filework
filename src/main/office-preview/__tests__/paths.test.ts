import { describe, expect, it } from "vitest";
import { resolveLibreOfficePath } from "../paths";

describe("Office preview path resolution", () => {
  it("uses FILEWORK_LIBREOFFICE_PATH when it is set", async () => {
    await expect(
      resolveLibreOfficePath({
        env: { FILEWORK_LIBREOFFICE_PATH: "/custom/soffice" },
        exists: async () => false,
        pathValue: "",
      }),
    ).resolves.toBe("/custom/soffice");
  });

  it("finds soffice on PATH", async () => {
    await expect(
      resolveLibreOfficePath({
        env: {},
        exists: async (path) => path === "/opt/bin/soffice",
        pathValue: "/opt/bin:/usr/bin",
      }),
    ).resolves.toBe("/opt/bin/soffice");
  });

  it("checks common macOS install locations when app PATH is minimal", async () => {
    await expect(
      resolveLibreOfficePath({
        commonPaths: ["/Applications/LibreOffice.app/Contents/MacOS/soffice"],
        env: {},
        exists: async (path) =>
          path === "/Applications/LibreOffice.app/Contents/MacOS/soffice",
        pathValue: "/usr/bin",
      }),
    ).resolves.toBe("/Applications/LibreOffice.app/Contents/MacOS/soffice");
  });
});
