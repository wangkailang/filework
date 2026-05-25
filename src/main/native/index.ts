import { createRequire } from "node:module";

/** Single file entry returned by the native duplicate finder. */
export interface NativeFileEntry {
  path: string;
  size: number;
}

/** Aggregated result of a native duplicate scan. */
export interface NativeDuplicateResult {
  scanned: number;
  skipped: number;
  duplicateGroups: number;
  totalWastedBytes: number;
  groups: NativeFileEntry[][];
}

interface NativeModule {
  findDuplicates(
    rootPath: string,
    extensions?: string[] | null,
  ): Promise<NativeDuplicateResult>;
}

// createRequire works in BOTH environments:
// - packaged Electron main process (bundled to CommonJS by electron-vite,
//   which supports import.meta.url in the main process), and
// - vitest (runs as ESM and provides import.meta.url natively).
// A bare top-level require(...) would throw "require is not defined" under
// vitest's ESM, so we must not use it.
const requireNative = createRequire(import.meta.url);

let native: NativeModule;
try {
  native = requireNative("@filework/native") as NativeModule;
} catch (error) {
  const original = error instanceof Error ? error.message : String(error);
  throw new Error(
    `Failed to load @filework/native — run 'pnpm install' to rebuild (requires Rust toolchain). Original error: ${original}`,
  );
}

/** Scan a directory for duplicate files using the native (Rust) implementation. */
export function findDuplicates(
  rootPath: string,
  extensions?: string[],
): Promise<NativeDuplicateResult> {
  return native.findDuplicates(rootPath, extensions);
}
