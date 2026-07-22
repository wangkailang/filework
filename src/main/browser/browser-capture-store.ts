import { randomUUID } from "node:crypto";

const DEFAULT_CAPTURE_TTL_MS = 5 * 60 * 1_000;
const DEFAULT_CAPTURE_MAX_BYTES = 32 * 1024 * 1024;

export interface BrowserCaptureStoreOptions {
  ttlMs?: number;
  maxBytes?: number;
  now?: () => number;
  createId?: () => string;
}

interface StoredCapture {
  bytes: Buffer;
  expiresAt: number;
}

export interface BrowserCaptureModelOutput {
  type: "file";
  mediaType: "image/png";
  data: { type: "data"; data: string };
}

/**
 * Short-lived, in-memory storage for browser screenshots. Keeping the bytes
 * behind an opaque id prevents screenshots from being serialized into task
 * JSONL alongside the ordinary browser observation.
 */
export class BrowserCaptureStore {
  private readonly captures = new Map<string, StoredCapture>();
  private readonly ttlMs: number;
  private readonly maxBytes: number;
  private readonly now: () => number;
  private readonly createId: () => string;
  private byteLength = 0;

  constructor(options: BrowserCaptureStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_CAPTURE_TTL_MS;
    this.maxBytes = options.maxBytes ?? DEFAULT_CAPTURE_MAX_BYTES;
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;

    if (!Number.isFinite(this.ttlMs) || this.ttlMs <= 0) {
      throw new Error("Browser capture TTL must be a positive number");
    }
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes <= 0) {
      throw new Error(
        "Browser capture memory limit must be a positive integer",
      );
    }
  }

  get size(): number {
    this.pruneExpired();
    return this.captures.size;
  }

  get totalBytes(): number {
    this.pruneExpired();
    return this.byteLength;
  }

  put(bytes: Buffer): string {
    this.pruneExpired();
    if (bytes.byteLength > this.maxBytes) {
      throw new Error("Browser capture exceeds the memory limit");
    }

    while (this.byteLength + bytes.byteLength > this.maxBytes) {
      const oldestId = this.captures.keys().next().value;
      if (typeof oldestId !== "string") break;
      this.delete(oldestId);
    }

    const id = this.uniqueId();
    const storedBytes = Buffer.from(bytes);
    this.captures.set(id, {
      bytes: storedBytes,
      expiresAt: this.now() + this.ttlMs,
    });
    this.byteLength += storedBytes.byteLength;
    return id;
  }

  get(id: string): Buffer | null {
    const capture = this.captures.get(id);
    if (!capture) return null;
    if (capture.expiresAt <= this.now()) {
      this.delete(id);
      return null;
    }

    // Map insertion order doubles as the LRU list.
    this.captures.delete(id);
    this.captures.set(id, capture);
    return Buffer.from(capture.bytes);
  }

  delete(id: string): boolean {
    const capture = this.captures.get(id);
    if (!capture) return false;
    this.captures.delete(id);
    this.byteLength -= capture.bytes.byteLength;
    return true;
  }

  clear(): void {
    this.captures.clear();
    this.byteLength = 0;
  }

  toModelOutput(id: string): BrowserCaptureModelOutput {
    const bytes = this.get(id);
    if (!bytes) throw new Error(`Browser capture not found or expired: ${id}`);
    return {
      type: "file",
      mediaType: "image/png",
      data: { type: "data", data: bytes.toString("base64") },
    };
  }

  private pruneExpired(): void {
    const now = this.now();
    for (const [id, capture] of this.captures) {
      if (capture.expiresAt <= now) this.delete(id);
    }
  }

  private uniqueId(): string {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const id = this.createId();
      if (id.length > 0 && !this.captures.has(id)) return id;
    }
    throw new Error("Unable to allocate a unique browser capture id");
  }
}
