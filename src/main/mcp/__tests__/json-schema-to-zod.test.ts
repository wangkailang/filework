import { describe, expect, it } from "vitest";
import { jsonSchemaToZodObject } from "../json-schema-to-zod";

describe("jsonSchemaToZodObject", () => {
  it("returns an empty object for missing/invalid input", () => {
    expect(jsonSchemaToZodObject(undefined).safeParse({}).success).toBe(true);
    expect(jsonSchemaToZodObject(null).safeParse({}).success).toBe(true);
  });

  it("requires fields listed in `required`", () => {
    const z = jsonSchemaToZodObject({
      type: "object",
      properties: {
        name: { type: "string" },
        age: { type: "integer" },
      },
      required: ["name"],
    });
    expect(z.safeParse({ name: "x" }).success).toBe(true);
    expect(z.safeParse({}).success).toBe(false);
    expect(z.safeParse({ name: "x", age: 1.5 }).success).toBe(false);
    expect(z.safeParse({ name: "x", age: 7 }).success).toBe(true);
  });

  it("handles string enums", () => {
    const z = jsonSchemaToZodObject({
      type: "object",
      properties: { mode: { type: "string", enum: ["read", "write"] } },
      required: ["mode"],
    });
    expect(z.safeParse({ mode: "read" }).success).toBe(true);
    expect(z.safeParse({ mode: "delete" }).success).toBe(false);
  });

  it("handles arrays of objects", () => {
    const z = jsonSchemaToZodObject({
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: { id: { type: "string" } },
            required: ["id"],
          },
        },
      },
    });
    expect(z.safeParse({ items: [{ id: "a" }, { id: "b" }] }).success).toBe(
      true,
    );
    expect(z.safeParse({ items: [{}] }).success).toBe(false);
  });

  it("supports nullable union via type array", () => {
    const z = jsonSchemaToZodObject({
      type: "object",
      properties: { name: { type: ["string", "null"] } },
      required: ["name"],
    });
    expect(z.safeParse({ name: "x" }).success).toBe(true);
    expect(z.safeParse({ name: null }).success).toBe(true);
    expect(z.safeParse({ name: 1 }).success).toBe(false);
  });

  it("treats `properties` without explicit type as object", () => {
    const z = jsonSchemaToZodObject({
      properties: { ok: { type: "boolean" } },
      required: ["ok"],
    });
    expect(z.safeParse({ ok: true }).success).toBe(true);
    expect(z.safeParse({}).success).toBe(false);
  });

  it("preserves unknown fields when additionalProperties=true", () => {
    const z = jsonSchemaToZodObject({
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: true,
    });
    const parsed = z.safeParse({ id: "a", extra: 42 });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect((parsed.data as { extra?: unknown }).extra).toBe(42);
    }
  });

  it("strips unknown fields by default", () => {
    const z = jsonSchemaToZodObject({
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    });
    const parsed = z.safeParse({ id: "a", extra: 42 });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect("extra" in (parsed.data as object)).toBe(false);
    }
  });

  it("resolves $ref against local $defs", () => {
    const z = jsonSchemaToZodObject({
      type: "object",
      properties: { item: { $ref: "#/$defs/Item" } },
      required: ["item"],
      $defs: {
        Item: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
      },
    });
    expect(z.safeParse({ item: { id: "x" } }).success).toBe(true);
    expect(z.safeParse({ item: {} }).success).toBe(false);
  });

  it("falls back to z.unknown for unsupported shapes", () => {
    const z = jsonSchemaToZodObject({
      type: "object",
      properties: { anything: {} },
    });
    expect(z.safeParse({ anything: { nested: true } }).success).toBe(true);
    expect(z.safeParse({ anything: "string is fine too" }).success).toBe(true);
  });
});
