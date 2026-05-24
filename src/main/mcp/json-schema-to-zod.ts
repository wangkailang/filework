/**
 * Convert a JSON-Schema fragment (the subset MCP servers emit for tool
 * `inputSchema`) into a Zod schema usable by `ai`'s tool definition.
 *
 * Coverage:
 *  - object (with `properties` + `required`, additionalProperties=false fallback)
 *  - string / number / integer / boolean / null
 *  - array (items, optional minItems/maxItems)
 *  - enum (string-only or mixed-literal)
 *  - oneOf / anyOf (z.union)
 *  - $ref to local definitions/$defs (depth-limited)
 *  - Anything unrecognized degrades to `z.unknown()` so the call still
 *    fires — MCP servers do their own validation server-side.
 *
 * Kept tiny (~one file, no deps) on purpose: pulling in
 * `json-schema-to-zod` etc. drags a whole JSON-Schema interpreter for
 * features MCP servers don't use.
 */

import { z } from "zod/v4";

type JsonSchema = Record<string, unknown>;

const MAX_DEPTH = 10;

const resolveRef = (
  schema: JsonSchema | undefined,
  ref: string,
  root: JsonSchema,
): JsonSchema | undefined => {
  // Only support local pointers — #/definitions/X or #/$defs/X.
  if (!ref.startsWith("#/")) return undefined;
  const parts = ref.slice(2).split("/");
  let cur: unknown = root;
  for (const p of parts) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur && typeof cur === "object" ? (cur as JsonSchema) : schema;
};

const buildZod = (
  schema: JsonSchema,
  root: JsonSchema,
  depth: number,
): z.ZodTypeAny => {
  if (depth > MAX_DEPTH) return z.unknown();
  if (!schema || typeof schema !== "object") return z.unknown();

  if (typeof schema.$ref === "string") {
    const target = resolveRef(schema, schema.$ref, root);
    return target ? buildZod(target, root, depth + 1) : z.unknown();
  }

  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    const strings = schema.enum.filter(
      (v): v is string => typeof v === "string",
    );
    if (strings.length === schema.enum.length && strings.length > 0) {
      return z.enum(strings as [string, ...string[]]);
    }
    const lits: z.ZodTypeAny[] = schema.enum.map((v) => z.literal(v as never));
    if (lits.length >= 2) {
      return z.union(
        lits as unknown as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]],
      );
    }
    return lits[0] ?? z.unknown();
  }

  const variants = (schema.oneOf ?? schema.anyOf) as JsonSchema[] | undefined;
  if (Array.isArray(variants) && variants.length > 0) {
    const built = variants.map((v) => buildZod(v, root, depth + 1));
    if (built.length === 1) return built[0];
    return z.union(built as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
  }

  const type = schema.type;
  if (Array.isArray(type)) {
    const nonNull = type.filter((t) => t !== "null");
    const nullable = type.includes("null");
    if (nonNull.length === 1) {
      const inner = buildZod({ ...schema, type: nonNull[0] }, root, depth + 1);
      return nullable ? inner.nullable() : inner;
    }
    const built = nonNull.map((t) =>
      buildZod({ ...schema, type: t }, root, depth + 1),
    );
    const union =
      built.length >= 2
        ? z.union(built as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]])
        : (built[0] ?? z.unknown());
    return nullable ? union.nullable() : union;
  }

  switch (type) {
    case "string":
      return z.string();
    case "number":
      return z.number();
    case "integer":
      return z.number().int();
    case "boolean":
      return z.boolean();
    case "null":
      return z.null();
    case "array": {
      const items = schema.items as JsonSchema | undefined;
      const inner = items ? buildZod(items, root, depth + 1) : z.unknown();
      let arr = z.array(inner);
      if (typeof schema.minItems === "number") arr = arr.min(schema.minItems);
      if (typeof schema.maxItems === "number") arr = arr.max(schema.maxItems);
      return arr;
    }
    case "object":
    case undefined: {
      const props = schema.properties as Record<string, JsonSchema> | undefined;
      // Schemas with `properties` but no explicit `type` are treated as
      // objects — common MCP shorthand. Bare schemas with neither type
      // nor properties fall through to z.unknown().
      if (!props && type !== "object") return z.unknown();
      const required = new Set(
        (Array.isArray(schema.required) ? schema.required : []) as string[],
      );
      const shape: Record<string, z.ZodTypeAny> = {};
      for (const [key, val] of Object.entries(props ?? {})) {
        let inner = buildZod(val, root, depth + 1);
        if (typeof (val as JsonSchema)?.description === "string") {
          inner = inner.describe((val as JsonSchema).description as string);
        }
        shape[key] = required.has(key) ? inner : inner.optional();
      }
      let obj: z.ZodTypeAny = z.object(shape);
      // additionalProperties=true keeps unknown fields; the zod default
      // (strip) is the safer baseline for tool-call args.
      if (schema.additionalProperties === true) {
        obj = (obj as z.ZodObject<z.ZodRawShape>).catchall(z.unknown());
      }
      return obj;
    }
    default:
      return z.unknown();
  }
};

/**
 * Top-level entry: accepts an MCP tool's `inputSchema` (always a JSON-
 * schema object describing the args object). Returns a ZodType so the
 * ai-sdk tool wrapper can treat it as a typed parameters schema. If the
 * top-level schema isn't object-typed, wrap it under `input` so ai-sdk
 * still has an object shape to validate against.
 */
export const jsonSchemaToZodObject = (
  schema: Record<string, unknown> | undefined | null,
): z.ZodTypeAny => {
  if (!schema || typeof schema !== "object") return z.object({});
  const built = buildZod(schema, schema, 0);
  if (built instanceof z.ZodObject) return built;
  return z.object({ input: built });
};
