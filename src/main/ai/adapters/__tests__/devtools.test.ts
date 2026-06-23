import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { __test__ } from "../devtools";

const maxBytes = 100 * 1024 * 1024;

function createDevtoolsLog(size: number): string {
  const cwd = mkdtempSync(join(tmpdir(), "filework-devtools-"));
  mkdirSync(join(cwd, ".devtools"));
  const logPath = join(cwd, ".devtools", "generations.json");
  writeFileSync(logPath, "");
  truncateSync(logPath, size);
  return cwd;
}

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("devtools runtime guard", () => {
  it("disables devtools and asks for cleanup when generations log exceeds 100MB", () => {
    const cwd = createDevtoolsLog(maxBytes + 1);
    tempDirs.push(cwd);

    const state = __test__.resolveDevtoolsState({
      cwd,
      env: {
        FILEWORK_AI_DEVTOOLS: "1",
        NODE_ENV: "development",
      },
    });

    expect(state.enabled).toBe(false);
    if (state.enabled) {
      throw new Error("Expected devtools to be disabled");
    }
    expect(state.reason).toBe("generations-log-too-large");
    expect(state.message).toContain(".devtools/generations.json");
    expect(state.message).toContain("100MB");
    expect(state.message).toContain("rm -f .devtools/generations.json");
  });

  it("allows devtools when generations log is exactly 100MB", () => {
    const cwd = createDevtoolsLog(maxBytes);
    tempDirs.push(cwd);

    const state = __test__.resolveDevtoolsState({
      cwd,
      env: {
        FILEWORK_AI_DEVTOOLS: "1",
        NODE_ENV: "development",
      },
    });

    expect(state).toEqual({ enabled: true });
  });
});
