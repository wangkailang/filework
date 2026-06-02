/**
 * 将 JSON-Schema 片段(MCP 服务端为工具 `inputSchema`
 * 输出的那个子集)转换为可供 `ai` 工具定义使用的 Zod schema。
 *
 * 覆盖范围:
 *  - object(含 `properties` + `required`,additionalProperties=false 兜底)
 *  - string / number / integer / boolean / null
 *  - array(items,可选的 minItems/maxItems)
 *  - enum(纯字符串或混合字面量)
 *  - oneOf / anyOf(z.union)
 *  - 指向本地 definitions/$defs 的 $ref(限制深度)
 *  - 任何无法识别的内容降级为 `z.unknown()`,以保证调用仍能
 *    发出 —— MCP 服务端会在自己一侧做校验。
 *
 * 刻意保持精简(约一个文件、无依赖):引入
 * `json-schema-to-zod` 等会为 MCP 服务端用不到的特性
 * 拖入一整套 JSON-Schema 解释器。
 */

import { z } from "zod/v4";

type JsonSchema = Record<string, unknown>;

const MAX_DEPTH = 10;

const resolveRef = (
  schema: JsonSchema | undefined,
  ref: string,
  root: JsonSchema,
): JsonSchema | undefined => {
  // 仅支持本地指针 —— #/definitions/X 或 #/$defs/X。
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
      // 有 `properties` 但没有显式 `type` 的 schema 视为
      // object —— 这是常见的 MCP 简写。既无 type 也无
      // properties 的裸 schema 则落到 z.unknown()。
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
      // additionalProperties=true 保留未知字段;zod 默认行为
      // (strip 剥除)对工具调用参数而言是更安全的基线。
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
 * 顶层入口:接收 MCP 工具的 `inputSchema`(始终是一个描述
 * 参数对象的 JSON-schema 对象)。返回一个 ZodType,以便
 * ai-sdk 的工具封装将其当作带类型的参数 schema。若顶层
 * schema 不是 object 类型,则将其包裹在 `input` 之下,从而让
 * ai-sdk 仍有一个 object 结构可供校验。
 */
export const jsonSchemaToZodObject = (
  schema: Record<string, unknown> | undefined | null,
): z.ZodTypeAny => {
  if (!schema || typeof schema !== "object") return z.object({});
  const built = buildZod(schema, schema, 0);
  if (built instanceof z.ZodObject) return built;
  return z.object({ input: built });
};
