# Office Preview Pipeline Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a local Office preview pipeline that converts Office files to cached PDFs, creates first-page thumbnails, and reuses the existing Electron PDF viewer.

**Architecture:** Add a Rust napi task in `@filework/native` that owns Office preview conversion orchestration: file fingerprinting, cache key creation, isolated LibreOffice profile/work directories, timeout handling, and a serialized conversion queue. Expose a narrow main-process IPC method that supplies the cache root and lets the renderer request a prepared PDF path for Office files.

**Tech Stack:** Rust + napi-rs for native orchestration, LibreOffice headless for Office-to-PDF conversion, optional PDF thumbnail command/Quick Look for PNG thumbnails, Electron IPC, React file preview components, Vitest and Cargo tests.

---

### Task 1: Rust Office Preview Orchestrator

**Files:**
- Create: `native/filework-native/src/office_preview.rs`
- Modify: `native/filework-native/src/lib.rs`
- Test: `native/filework-native/src/office_preview.rs`

**Steps:**
1. Write failing Rust tests for cache keys, fake LibreOffice conversion, thumbnail output, timeout failure, and serialized conversion misses.
2. Run `cargo test office_preview --manifest-path native/filework-native/Cargo.toml` and confirm the tests fail because the feature is missing.
3. Implement minimal Rust logic:
   - Stat and hash the source file.
   - Resolve LibreOffice path from options, env, PATH, or macOS default.
   - Read converter version with `--version`.
   - Build cache key from canonical path, mtime, size, file hash, and converter version.
   - Use a global mutex to serialize conversion cache misses.
   - Use a per-job temp directory and `-env:UserInstallation=file://...` for LibreOffice isolation.
   - Kill the converter when timeout elapses.
   - Atomically publish `preview.pdf` and optional `thumbnail.png`.
4. Re-run the focused Cargo tests until green.

### Task 2: Native TypeScript Bridge and IPC

**Files:**
- Modify: `src/main/native/index.ts`
- Modify: `src/main/ipc/file-handlers.ts`
- Modify: `src/preload/index.ts`
- Test: focused Vitest for helper behavior if extracted.

**Steps:**
1. Add TypeScript interfaces for `OfficePreviewOptions` and `OfficePreviewResult`.
2. Export `prepareOfficePreview` from `src/main/native/index.ts`.
3. Add `fs:prepareOfficePreview` IPC handler that supplies `~/.filework/previews/office` as cache root and calls native.
4. Expose `window.filework.prepareOfficePreview(path)`.

### Task 3: Renderer Preview Integration

**Files:**
- Modify: `src/renderer/components/file-preview/FilePreviewPanel.tsx`
- Modify: `src/renderer/components/file-preview/PdfViewer.tsx` if needed.
- Test: `src/renderer/components/file-preview/__tests__/FilePreviewPanel.office.test.tsx`

**Steps:**
1. Write failing renderer test for `.docx` requesting Office preparation and rendering the returned PDF path through `PdfViewer`.
2. Add Office extension detection for `doc`, `docx`, `xls`, `xlsx`, `ppt`, `pptx`, and common macro/template variants.
3. Add loading/error handling that mirrors existing text preview behavior.
4. Keep actual preview rendering in `PdfViewer` via `local-file://`.

### Task 4: Verification

**Files:**
- Affected source and test files.

**Steps:**
1. Run focused Cargo and Vitest checks.
2. Run `pnpm lint`.
3. Run `pnpm typecheck`.
4. Run `pnpm test` if core logic breadth requires it.
5. Run `pnpm build` because main and renderer are modified.
