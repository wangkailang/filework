# `@filework/native` Dedup Trial Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the JS duplicate-finder with a Rust napi-rs native module (`@filework/native`), validating the full Rust → `.node` → electron-builder packaging chain.

**Architecture:** A local pnpm workspace package `native/filework-native` exposes an async `findDuplicates(rootPath, extensions?)` function via napi-rs. A reusable parallel walker (`walker.rs`) feeds a size-bucketing + blake3 dedup engine (`dedup.rs`). The TS skill becomes a thin wrapper; the old JS hashing is deleted (hard native dependency).

**Tech Stack:** Rust (napi-rs 2.x, jwalk, blake3, rayon), pnpm workspaces, electron-vite (`externalizeDepsPlugin`), electron-builder, vitest.

---

## File Structure

- Create: `pnpm-workspace.yaml` — declare `native/*` workspace.
- Create: `native/filework-native/Cargo.toml` — crate manifest.
- Create: `native/filework-native/build.rs` — napi build setup.
- Create: `native/filework-native/package.json` — `@filework/native`, napi build script.
- Create: `native/filework-native/src/lib.rs` — `#[napi]` binding + `AsyncTask`.
- Create: `native/filework-native/src/walker.rs` — reusable parallel file walker.
- Create: `native/filework-native/src/dedup.rs` — size-bucket + blake3 dedup logic.
- Create: `native/filework-native/.gitignore` — ignore `target/`, generated `*.node`.
- Create: `src/main/native/index.ts` — typed loader with hard-fail error message.
- Modify: `package.json` — add dependency `@filework/native`, extend `postinstall`.
- Modify: `src/main/skills/duplicate-finder.ts` — thin `execute`, delete `hashFile`.
- Create: `src/main/skills/__tests__/duplicate-finder.test.ts` — TS integration test.
- Modify: `electron-builder.yml` — pack node_modules + asarUnpack `.node`.

**Semantics note (locked decision):** `scanned` = number of *candidate* files (passed filters, non-empty, ≤100 MB). `skipped` = files >100 MB + files that errored during walk/stat/read. This preserves the meaning of the old `scanned` number (old code hashed every candidate, so hashed-count == candidate-count). Empty files are ignored (counted in neither), matching `duplicate-finder.ts:61`.

---

## Task 0: Verify toolchain & install napi CLI

**Files:** none (environment setup)

- [ ] **Step 1: Verify Rust toolchain is present**

Run: `cargo --version && rustc --version`
Expected: both print versions (e.g. `cargo 1.7x.x`, `rustc 1.7x.x`). If `rustc` is missing, run `rustup default stable` then retry.

- [ ] **Step 2: Verify pnpm**

Run: `pnpm --version`
Expected: prints a version (project uses pnpm; `pnpm-lock.yaml` exists).

- [ ] **Step 3: Proceed**

No commit yet — proceed to Task 1.

---

## Task 1: Walking skeleton — scaffold workspace package with a trivial `#[napi]` function

This task validates the entire build → import chain BEFORE any real logic. Do not skip; this is the point of phase one.

**Files:**
- Create: `pnpm-workspace.yaml`
- Create: `native/filework-native/Cargo.toml`
- Create: `native/filework-native/build.rs`
- Create: `native/filework-native/package.json`
- Create: `native/filework-native/.gitignore`
- Create: `native/filework-native/src/lib.rs`
- Modify: `package.json`

- [ ] **Step 1: Create the pnpm workspace declaration**

Create `pnpm-workspace.yaml`:

```yaml
packages:
  - native/*
```

- [ ] **Step 2: Create the Cargo manifest**

Create `native/filework-native/Cargo.toml`:

```toml
[package]
name = "filework-native"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib"]

[dependencies]
napi = { version = "2", default-features = false, features = ["napi6"] }
napi-derive = "2"
jwalk = "0.8"
blake3 = "1"
rayon = "1"

[dev-dependencies]
tempfile = "3"

[build-dependencies]
napi-build = "2"

[profile.release]
lto = true
```

- [ ] **Step 3: Create the build script**

Create `native/filework-native/build.rs`:

```rust
fn main() {
    napi_build::setup();
}
```

- [ ] **Step 4: Create the package manifest**

Create `native/filework-native/package.json`:

```json
{
  "name": "@filework/native",
  "version": "0.1.0",
  "main": "index.js",
  "types": "index.d.ts",
  "napi": {
    "name": "filework-native"
  },
  "scripts": {
    "build": "napi build --platform --release",
    "build:debug": "napi build --platform"
  },
  "devDependencies": {
    "@napi-rs/cli": "^2.18.4"
  }
}
```

- [ ] **Step 5: Create .gitignore for build artifacts**

Create `native/filework-native/.gitignore`:

```
target/
*.node
index.js
index.d.ts
```

- [ ] **Step 6: Write a trivial `#[napi]` function**

Create `native/filework-native/src/lib.rs`:

```rust
use napi_derive::napi;

#[napi]
pub fn ping() -> String {
    "filework-native: ok".to_string()
}
```

- [ ] **Step 7: Wire the workspace dependency and postinstall build**

In root `package.json`, add to `dependencies` (keep alphabetical near other `@` scopes):

```json
"@filework/native": "workspace:*",
```

Change the `postinstall` script from:

```json
"postinstall": "electron-rebuild -f -w better-sqlite3"
```

to:

```json
"postinstall": "electron-rebuild -f -w better-sqlite3 && pnpm --filter @filework/native run build"
```

- [ ] **Step 8: Install and build**

Run: `pnpm install`
Expected: install completes; postinstall runs `napi build`, producing `native/filework-native/filework-native.darwin-*.node`, `index.js`, and `index.d.ts`. The `node_modules/@filework/native` symlink resolves to `native/filework-native`.

- [ ] **Step 9: Verify the import chain works**

Run: `node -e "const n=require('@filework/native'); console.log(n.ping());"`
Expected: prints `filework-native: ok`.

- [ ] **Step 10: Commit the walking skeleton**

```bash
git add pnpm-workspace.yaml native/filework-native/Cargo.toml native/filework-native/build.rs native/filework-native/package.json native/filework-native/.gitignore native/filework-native/src/lib.rs package.json pnpm-lock.yaml
git commit -m "feat(native): scaffold @filework/native with ping walking skeleton"
```

---

## Task 2: Walker module — parallel filtered traversal (TDD)

**Files:**
- Create: `native/filework-native/src/walker.rs`
- Modify: `native/filework-native/src/lib.rs` (add `mod walker;`)

- [ ] **Step 1: Write the test + implementation**

Create `native/filework-native/src/walker.rs`:

```rust
use jwalk::WalkDir;
use std::path::Path;

/// A file discovered by the walker, with its size in bytes.
pub struct Walked {
    pub path: String,
    pub size: u64,
}

/// Walk `root` recursively, returning regular files that pass the filters,
/// plus a count of entries skipped due to traversal/metadata errors.
///
/// Filters applied:
/// - skip entries whose name starts with `.`
/// - skip any path containing `/.filework/` or `/node_modules/`
/// - if `extensions` is `Some` and non-empty, keep only matching extensions
///   (compared lowercase, with leading dot, e.g. `.jpg`)
pub fn walk_files(root: &str, extensions: Option<&[String]>) -> (Vec<Walked>, u32) {
    let mut files = Vec::new();
    let mut skipped: u32 = 0;

    let exts_lower: Option<Vec<String>> = extensions.map(|list| {
        list.iter()
            .filter(|e| !e.is_empty())
            .map(|e| e.to_lowercase())
            .collect()
    });

    for entry in WalkDir::new(root).skip_hidden(false) {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => {
                skipped += 1;
                continue;
            }
        };

        if !entry.file_type().is_file() {
            continue;
        }

        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }

        let path = entry.path();
        let path_str = path.to_string_lossy().to_string();
        if path_str.contains("/.filework/") || path_str.contains("/node_modules/") {
            continue;
        }

        if let Some(ref exts) = exts_lower {
            if !exts.is_empty() && !match_extension(&path, exts) {
                continue;
            }
        }

        let size = match entry.metadata() {
            Ok(m) => m.len(),
            Err(_) => {
                skipped += 1;
                continue;
            }
        };

        files.push(Walked { path: path_str, size });
    }

    (files, skipped)
}

fn match_extension(path: &Path, exts_lower: &[String]) -> bool {
    match path.extension().and_then(|e| e.to_str()) {
        Some(ext) => {
            let with_dot = format!(".{}", ext.to_lowercase());
            exts_lower.iter().any(|e| *e == with_dot)
        }
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn skips_hidden_files_and_ignored_dirs() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("a.txt"), b"hello").unwrap();
        fs::write(root.join(".hidden"), b"secret").unwrap();
        fs::create_dir(root.join("node_modules")).unwrap();
        fs::write(root.join("node_modules").join("pkg.txt"), b"x").unwrap();

        let (files, _skipped) = walk_files(root.to_str().unwrap(), None);
        let names: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(files.len(), 1, "only a.txt should pass, got {:?}", names);
        assert!(files[0].path.ends_with("a.txt"));
        assert_eq!(files[0].size, 5);
    }

    #[test]
    fn filters_by_extension() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("photo.JPG"), b"img").unwrap();
        fs::write(root.join("notes.txt"), b"text").unwrap();

        let exts = vec![".jpg".to_string()];
        let (files, _) = walk_files(root.to_str().unwrap(), Some(&exts));
        assert_eq!(files.len(), 1);
        assert!(files[0].path.ends_with("photo.JPG"));
    }
}
```

In `native/filework-native/src/lib.rs`, add at the top:

```rust
mod walker;
```

- [ ] **Step 2: Run the test to verify it compiles and passes**

Run: `cd native/filework-native && cargo test walker`
Expected: PASS (2 tests). If the first run fails to compile due to a typo, fix and rerun.

- [ ] **Step 3: Commit**

```bash
git add native/filework-native/src/walker.rs native/filework-native/src/lib.rs
git commit -m "feat(native): parallel filtered file walker with tests"
```

---

## Task 3: Dedup engine — size bucketing + blake3 (TDD)

**Files:**
- Create: `native/filework-native/src/dedup.rs`
- Modify: `native/filework-native/src/lib.rs` (add `mod dedup;`)

- [ ] **Step 1: Write the test + implementation**

Create `native/filework-native/src/dedup.rs`:

```rust
use crate::walker::walk_files;
use rayon::prelude::*;
use std::collections::HashMap;
use std::io;
use std::sync::atomic::{AtomicU32, Ordering};

const MAX_FILE_BYTES: u64 = 100 * 1024 * 1024; // 100 MB
const MAX_GROUPS: usize = 50;

/// Plain-Rust dedup result (converted to a napi object in lib.rs).
pub struct DedupOutput {
    pub scanned: u32,
    pub skipped: u32,
    pub duplicate_groups: u32,
    pub total_wasted_bytes: f64,
    /// Each group is a list of (path, size), groups sorted by wasted space desc.
    pub groups: Vec<Vec<(String, u64)>>,
}

/// Map an io error to a tagged message matching the renderer's FS_ERROR_TAG.
fn tag_io_error(err: &io::Error, path: &str) -> String {
    match err.kind() {
        io::ErrorKind::NotFound => format!("FS_NOT_FOUND {}", path),
        io::ErrorKind::PermissionDenied => format!("FS_PERMISSION_DENIED {}", path),
        _ => err.to_string(),
    }
}

fn hash_file(path: &str) -> io::Result<blake3::Hash> {
    let mut hasher = blake3::Hasher::new();
    let mut file = std::fs::File::open(path)?;
    io::copy(&mut file, &mut hasher)?;
    Ok(hasher.finalize())
}

pub fn find_duplicates(
    root: &str,
    extensions: Option<&[String]>,
) -> Result<DedupOutput, String> {
    // Fail fast if the root is unusable.
    let meta = std::fs::metadata(root).map_err(|e| tag_io_error(&e, root))?;
    if !meta.is_dir() {
        return Err(format!("FS_NOT_FOUND {} (not a directory)", root));
    }

    let (walked, walk_skipped) = walk_files(root, extensions);
    let skipped = AtomicU32::new(walk_skipped);

    // Candidates: non-empty, <= 100 MB. Oversized files count as skipped.
    let mut candidates: Vec<(String, u64)> = Vec::new();
    for w in walked {
        if w.size == 0 {
            continue; // ignored, matches old behavior
        }
        if w.size > MAX_FILE_BYTES {
            skipped.fetch_add(1, Ordering::Relaxed);
            continue;
        }
        candidates.push((w.path, w.size));
    }
    let scanned = candidates.len() as u32;

    // Bucket by size; only sizes with >1 file can contain duplicates.
    let mut by_size: HashMap<u64, Vec<String>> = HashMap::new();
    for (path, size) in candidates {
        by_size.entry(size).or_default().push(path);
    }
    let to_hash: Vec<(String, u64)> = by_size
        .into_iter()
        .filter(|(_, paths)| paths.len() > 1)
        .flat_map(|(size, paths)| paths.into_iter().map(move |p| (p, size)))
        .collect();

    // Hash candidates in parallel; read errors count as skipped.
    let hashed: Vec<(blake3::Hash, String, u64)> = to_hash
        .par_iter()
        .filter_map(|(path, size)| match hash_file(path) {
            Ok(h) => Some((h, path.clone(), *size)),
            Err(_) => {
                skipped.fetch_add(1, Ordering::Relaxed);
                None
            }
        })
        .collect();

    // Group by hash.
    let mut by_hash: HashMap<blake3::Hash, Vec<(String, u64)>> = HashMap::new();
    for (h, path, size) in hashed {
        by_hash.entry(h).or_default().push((path, size));
    }

    let mut groups: Vec<Vec<(String, u64)>> = by_hash
        .into_values()
        .filter(|g| g.len() > 1)
        .collect();

    // Sort by wasted space (size * count) descending.
    groups.sort_by(|a, b| {
        let wa = a[0].1 as u128 * a.len() as u128;
        let wb = b[0].1 as u128 * b.len() as u128;
        wb.cmp(&wa)
    });

    let total_wasted_bytes: f64 = groups
        .iter()
        .map(|g| (g[0].1 as f64) * ((g.len() - 1) as f64))
        .sum();

    let duplicate_groups = groups.len() as u32;
    groups.truncate(MAX_GROUPS);

    Ok(DedupOutput {
        scanned,
        skipped: skipped.load(Ordering::Relaxed),
        duplicate_groups,
        total_wasted_bytes,
        groups,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn finds_duplicates_and_ignores_unique_sizes() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        // Two identical files (same content + size) => one duplicate group.
        fs::write(root.join("a.bin"), b"DUPLICATE").unwrap();
        fs::write(root.join("b.bin"), b"DUPLICATE").unwrap();
        // A unique file.
        fs::write(root.join("c.bin"), b"unique-content").unwrap();
        // Empty file is ignored.
        fs::write(root.join("empty.bin"), b"").unwrap();

        let out = find_duplicates(root.to_str().unwrap(), None).unwrap();
        assert_eq!(out.duplicate_groups, 1);
        assert_eq!(out.groups[0].len(), 2);
        assert_eq!(out.total_wasted_bytes, "DUPLICATE".len() as f64);
        // scanned = a, b, c (empty ignored).
        assert_eq!(out.scanned, 3);
    }

    #[test]
    fn same_size_different_content_is_not_a_duplicate() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("x.bin"), b"AAAA").unwrap();
        fs::write(root.join("y.bin"), b"BBBB").unwrap(); // same size, different bytes
        let out = find_duplicates(root.to_str().unwrap(), None).unwrap();
        assert_eq!(out.duplicate_groups, 0);
    }

    #[test]
    fn missing_root_returns_tagged_error() {
        let err = find_duplicates("/no/such/path/xyz", None).unwrap_err();
        assert!(err.starts_with("FS_NOT_FOUND"), "got: {}", err);
    }
}
```

In `native/filework-native/src/lib.rs`, add near the top (after `mod walker;`):

```rust
mod dedup;
```

- [ ] **Step 2: Run the dedup tests**

Run: `cd native/filework-native && cargo test dedup`
Expected: PASS (3 tests).

- [ ] **Step 3: Run the full Rust suite**

Run: `cd native/filework-native && cargo test`
Expected: PASS (5 tests total: 2 walker + 3 dedup).

- [ ] **Step 4: Commit**

```bash
git add native/filework-native/src/dedup.rs native/filework-native/src/lib.rs
git commit -m "feat(native): size-bucket + blake3 dedup engine with tests"
```

---

## Task 4: napi binding — async `findDuplicates`

**Files:**
- Modify: `native/filework-native/src/lib.rs`

- [ ] **Step 1: Replace lib.rs with the full binding**

Overwrite `native/filework-native/src/lib.rs` with:

```rust
mod dedup;
mod walker;

use napi::bindgen_prelude::*;
use napi_derive::napi;

#[napi(object)]
pub struct FileEntry {
    pub path: String,
    pub size: f64,
}

#[napi(object)]
pub struct DuplicateResult {
    pub scanned: u32,
    pub skipped: u32,
    pub duplicate_groups: u32,
    pub total_wasted_bytes: f64,
    pub groups: Vec<Vec<FileEntry>>,
}

impl From<dedup::DedupOutput> for DuplicateResult {
    fn from(o: dedup::DedupOutput) -> Self {
        let groups = o
            .groups
            .into_iter()
            .map(|g| {
                g.into_iter()
                    .map(|(path, size)| FileEntry {
                        path,
                        size: size as f64,
                    })
                    .collect()
            })
            .collect();
        DuplicateResult {
            scanned: o.scanned,
            skipped: o.skipped,
            duplicate_groups: o.duplicate_groups,
            total_wasted_bytes: o.total_wasted_bytes,
            groups,
        }
    }
}

pub struct FindDuplicatesTask {
    root: String,
    extensions: Option<Vec<String>>,
}

impl Task for FindDuplicatesTask {
    type Output = dedup::DedupOutput;
    type JsValue = DuplicateResult;

    fn compute(&mut self) -> Result<Self::Output> {
        dedup::find_duplicates(&self.root, self.extensions.as_deref())
            .map_err(|msg| Error::new(Status::GenericFailure, msg))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output.into())
    }
}

#[napi(ts_return_type = "Promise<DuplicateResult>")]
pub fn find_duplicates(
    root_path: String,
    extensions: Option<Vec<String>>,
) -> AsyncTask<FindDuplicatesTask> {
    AsyncTask::new(FindDuplicatesTask {
        root: root_path,
        extensions,
    })
}
```

- [ ] **Step 2: Rebuild the native module**

Run: `pnpm --filter @filework/native run build`
Expected: build succeeds; `index.d.ts` now declares `export function findDuplicates(rootPath: string, extensions?: Array<string> | undefined | null): Promise<DuplicateResult>`.

- [ ] **Step 3: Verify the binding from Node against a temp fixture**

Run:
```bash
node -e '
const fs=require("fs"),os=require("os"),path=require("path");
const d=fs.mkdtempSync(path.join(os.tmpdir(),"dedup-"));
fs.writeFileSync(path.join(d,"a.bin"),"DUP");
fs.writeFileSync(path.join(d,"b.bin"),"DUP");
require("@filework/native").findDuplicates(d).then(r=>{
  console.log(JSON.stringify(r));
  if(r.duplicateGroups!==1) process.exit(1);
  console.log("OK");
});'
```
Expected: prints a JSON object with `"duplicateGroups":1` and `"groups"` containing one 2-element array, then `OK`. Confirms camelCase field mapping and async resolution.

- [ ] **Step 4: Commit**

```bash
git add native/filework-native/src/lib.rs
git commit -m "feat(native): async findDuplicates napi binding"
```

---

## Task 5: TS loader + skill integration (delete old JS path)

**Files:**
- Create: `src/main/native/index.ts`
- Modify: `src/main/skills/duplicate-finder.ts`
- Create: `src/main/skills/__tests__/duplicate-finder.test.ts`

- [ ] **Step 1: Write the typed loader with hard-fail message**

Create `src/main/native/index.ts`:

```ts
// Thin typed loader for the @filework/native addon.
// Hard dependency: if the native module fails to load, we fail loudly with a
// repair hint rather than silently degrading.

export interface NativeFileEntry {
  path: string;
  size: number;
}

export interface NativeDuplicateResult {
  scanned: number;
  skipped: number;
  duplicateGroups: number;
  totalWastedBytes: number;
  groups: NativeFileEntry[][];
}

interface FileworkNative {
  findDuplicates(
    rootPath: string,
    extensions?: string[],
  ): Promise<NativeDuplicateResult>;
}

let native: FileworkNative;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  native = require("@filework/native") as FileworkNative;
} catch (err) {
  throw new Error(
    "Failed to load @filework/native — run 'pnpm install' to rebuild " +
      `(requires Rust toolchain). Original error: ${
        err instanceof Error ? err.message : String(err)
      }`,
  );
}

export const findDuplicates = (
  rootPath: string,
  extensions?: string[],
): Promise<NativeDuplicateResult> => native.findDuplicates(rootPath, extensions);
```

- [ ] **Step 2: Rewrite the skill to a thin wrapper**

In `src/main/skills/duplicate-finder.ts`:

Delete the `hashFile` helper (lines 8-12) and the entire imperative scan body inside `execute` (the `readdir`/`for`/`hashMap` logic, lines 33-87). Replace the imports and the tool's `execute` so the top of the file reads exactly:

```ts
import type { Tool } from "ai";
import { z } from "zod/v4";
import { findDuplicates } from "../native";
import type { Skill } from "./types";

const findDuplicatesTool: Tool = {
  description:
    "Scan a directory for duplicate files by computing file hashes. Returns groups of duplicate files.",
  inputSchema: z.object({
    path: z.string().describe("Absolute path to the directory to scan"),
    extensions: z
      .array(z.string())
      .optional()
      .describe(
        "Optional list of extensions to filter (e.g. ['.jpg', '.png'])",
      ),
  }),
  execute: async ({
    path: dirPath,
    extensions,
  }: {
    path: string;
    extensions?: string[];
  }) => findDuplicates(dirPath, extensions),
};
```

Leave the `export const duplicateFinder: Skill = { ... }` block (id, name, keywords, suggestions, tools, systemPrompt) completely unchanged. The now-removed imports are `createHash`, `readdir`, `readFile`, `stat`, `extname`, `join`.

- [ ] **Step 3: Write the TS integration test**

Create `src/main/skills/__tests__/duplicate-finder.test.ts`:

```ts
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
```

- [ ] **Step 4: Run the TS test**

Run: `pnpm test -- duplicate-finder`
Expected: PASS (2 tests). This also proves the `.node` loads under the vitest (Node) runtime.

- [ ] **Step 5: Typecheck and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: no type errors; biome passes. Fix any unused-import errors flagged in `duplicate-finder.ts`.

- [ ] **Step 6: Commit**

```bash
git add src/main/native/index.ts src/main/skills/duplicate-finder.ts src/main/skills/__tests__/duplicate-finder.test.ts
git commit -m "feat(skills): route duplicate-finder through @filework/native, drop JS hashing"
```

---

## Task 6: Packaging validation (the core phase-one goal)

Validate the `.node` survives an electron-builder production build for the **host arch** and loads in the packaged app. Dual-arch (x64 + arm64) cross-compile is explicitly deferred (see Risks in the spec).

**Files:**
- Modify: `electron-builder.yml`

- [ ] **Step 1: Confirm dev build externalizes the addon**

Run: `pnpm build`
Expected: `electron-vite build` succeeds. Because `@filework/native` is in `dependencies`, `externalizeDepsPlugin` leaves it as a runtime `require` (not bundled).

Run: `grep -rl "@filework/native" out/main || echo "NOT-EXTERNALIZED"`
Expected: a match in `out/main` (proves it's externalized, not inlined). If `NOT-EXTERNALIZED`, the addon was bundled — stop and investigate the externalize config.

- [ ] **Step 2: Make electron-builder pack node_modules and unpack the .node**

In `electron-builder.yml`, replace:

```yaml
files:
  - out/**/*
  - package.json
```

with:

```yaml
files:
  - out/**/*
  - package.json
  - node_modules/@filework/native/**/*
asarUnpack:
  - "**/*.node"
```

Rationale: native `.node` binaries cannot be loaded from inside an asar archive, so they must be unpacked. The explicit `node_modules/@filework/native/**/*` entry guarantees the pnpm-symlinked workspace package is included.

- [ ] **Step 3: Package for the host architecture only**

Determine host arch:

Run: `node -p "process.arch"`
Expected: `arm64` (Apple Silicon) or `x64`.

Run (substitute `<arch>`): `pnpm exec electron-builder --mac --<arch>`
Expected: build completes; a `.app` is produced under `release/mac-<arch>/` (or `release/mac/`). Note: the default `pnpm package` (both arches) will fail to load on the non-host arch because this phase produces only a host-arch `.node` — expected and deferred.

- [ ] **Step 4: Verify the .node landed in the package**

Run: `find "release/mac"*/FileWork.app/Contents/Resources -name "*.node"`
Expected: lists `filework-native.darwin-*.node` under `app.asar.unpacked/.../@filework/native/`. If absent, revisit Step 2's `files`/`asarUnpack`.

- [ ] **Step 5: Launch the packaged app and exercise dedup**

Run: `open release/mac*/FileWork.app` (adjust to the produced `.app`).
In the running app, trigger a duplicate-find on a folder known to contain duplicates (via chat: "找出这个目录下重复的文件" pointing at a test folder).
Expected: results return without a "Failed to load @filework/native" error.

- [ ] **Step 6: Commit the packaging config**

```bash
git add electron-builder.yml
git commit -m "build: pack and asarUnpack @filework/native for production builds"
```

---

## Task 7: Benchmark (throwaway, not committed to main code)

**Files:**
- Create (temporary): `/tmp/bench-dedup.mjs` (do NOT add to the repo)

- [ ] **Step 1: Pick or create a benchmark corpus**

Use a real directory with many files (a downloads-folder copy or a sample tree with deliberate duplicates). Record file count and total size:

Run: `find <CORPUS_DIR> -type f | wc -l && du -sh <CORPUS_DIR>`

- [ ] **Step 2: Write the throwaway benchmark script**

Create `/tmp/bench-dedup.mjs`:

```js
import { performance } from "node:perf_hooks";
const { findDuplicates } = await import("@filework/native");
const dir = process.argv[2];
if (!dir) {
  console.error("usage: node /tmp/bench-dedup.mjs <dir>");
  process.exit(1);
}
const t0 = performance.now();
const r = await findDuplicates(dir);
const t1 = performance.now();
console.log(
  `native: ${(t1 - t0).toFixed(0)}ms — scanned=${r.scanned} skipped=${r.skipped} groups=${r.duplicateGroups} wasted=${(r.totalWastedBytes / 1e6).toFixed(1)}MB`,
);
```

- [ ] **Step 3: Run the native benchmark**

Run: `node /tmp/bench-dedup.mjs <CORPUS_DIR>`
Expected: prints timing + stats. Record the number.

- [ ] **Step 4: Compare against the old JS implementation**

Recover the pre-change `duplicate-finder.ts` logic into a second throwaway script (the old `readFile` + `createHash("md5")` loop) and time the same corpus. Record both numbers.

- [ ] **Step 5: Record results (no code commit)**

Add the before/after timings to the PR description when opening the PR. Delete `/tmp/bench-dedup.mjs`.

---

## Final Verification

- [ ] `cd native/filework-native && cargo test` → all pass (5 tests)
- [ ] `pnpm test -- duplicate-finder` → all pass (2 tests)
- [ ] `pnpm typecheck && pnpm lint` → clean
- [ ] Packaged `.app` runs dedup without native-load error
- [ ] Benchmark numbers captured for the PR
