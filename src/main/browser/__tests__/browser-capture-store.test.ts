import { describe, expect, it } from "vitest";

import { BrowserCaptureStore } from "../browser-capture-store";

describe("BrowserCaptureStore", () => {
  it("expires captures after the configured TTL", () => {
    let now = 1_000;
    const store = new BrowserCaptureStore({
      now: () => now,
      ttlMs: 500,
      createId: () => "capture-1",
    });
    const id = store.put(Buffer.from("png"));

    expect(store.get(id)?.toString()).toBe("png");
    now = 1_501;
    expect(store.get(id)).toBeNull();
    expect(store.size).toBe(0);
  });

  it("evicts the least recently used captures before exceeding memory", () => {
    let nextId = 0;
    const store = new BrowserCaptureStore({
      maxBytes: 8,
      createId: () => `capture-${++nextId}`,
    });
    const first = store.put(Buffer.from("1111"));
    const second = store.put(Buffer.from("2222"));
    expect(store.get(first)).not.toBeNull(); // first becomes most recent

    const third = store.put(Buffer.from("3333"));

    expect(store.get(first)?.toString()).toBe("1111");
    expect(store.get(second)).toBeNull();
    expect(store.get(third)?.toString()).toBe("3333");
    expect(store.totalBytes).toBe(8);
  });

  it("rejects a single capture larger than the entire store", () => {
    const store = new BrowserCaptureStore({ maxBytes: 3 });
    expect(() => store.put(Buffer.from("large"))).toThrow(/limit/i);
  });

  it("projects screenshot bytes into a model-only file content block", () => {
    const store = new BrowserCaptureStore({ createId: () => "capture-1" });
    const id = store.put(Buffer.from("png"));

    expect(store.toModelOutput(id)).toEqual({
      type: "file",
      mediaType: "image/png",
      data: { type: "data", data: Buffer.from("png").toString("base64") },
    });
  });
});
