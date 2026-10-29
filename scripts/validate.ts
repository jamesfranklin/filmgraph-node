/** Small JSON-Schema subset validator for FilmGraph node records. Covers what
 *  schema/v1/nodes.json actually uses (type, required, additionalProperties,
 *  properties, enum, pattern, minLength, minimum, items, nullable type arrays).
 *  Vendored schema: schema/v1/ — copy from the FilmGraph repo when it changes. */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const NODE_SCHEMAS = JSON.parse(readFileSync(join(here, "..", "schema", "v1", "nodes.json"), "utf8")) as Record<
  string,
  Schema
>;
export const EDGE_SCHEMAS = JSON.parse(readFileSync(join(here, "..", "schema", "v1", "edges.json"), "utf8")) as Record<
  string,
  Schema
>;
export type NodeType = keyof typeof NODE_SCHEMAS & string;

interface Schema {
  type?: string | string[];
  required?: string[];
  additionalProperties?: boolean | Schema;
  properties?: Record<string, Schema>;
  enum?: unknown[];
  pattern?: string;
  minLength?: number;
  minimum?: number;
  items?: Schema;
  format?: string;
}

const typeOf = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v);

export function validate(schema: Schema, value: unknown, path = ""): string[] {
  const errs: string[] = [];
  const at = path || "(root)";
  if (schema.type) {
    const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
    const t = typeOf(value);
    const ok = allowed.includes(t) || (allowed.includes("number") && t === "integer");
    if (!ok) return [`${at}: expected ${allowed.join("|")}, got ${t}`];
  }
  if (schema.enum && !schema.enum.includes(value)) errs.push(`${at}: not one of ${schema.enum.join(", ")}`);
  if (typeof value === "string") {
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errs.push(`${at}: '${value}' does not match ${schema.pattern}`);
    if (schema.minLength !== undefined && value.length < schema.minLength) errs.push(`${at}: too short`);
  }
  if (typeof value === "number" && schema.minimum !== undefined && value < schema.minimum) errs.push(`${at}: below ${schema.minimum}`);
  if (Array.isArray(value) && schema.items) value.forEach((v, i) => errs.push(...validate(schema.items!, v, `${path}[${i}]`)));
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    // JS callers often carry `undefined` for absent fields; treat as absent.
    for (const r of schema.required ?? []) if (obj[r] === undefined) errs.push(`${at}: '${r}' is a required property`);
    for (const [k, v] of Object.entries(obj)) {
      if (v === undefined) continue;
      const sub = schema.properties?.[k];
      if (sub) errs.push(...validate(sub, v, path ? `${path}.${k}` : k));
      else if (schema.additionalProperties === false) errs.push(`${at}: additional property '${k}' not allowed`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === "object")
        errs.push(...validate(schema.additionalProperties, v, path ? `${path}.${k}` : k));
    }
  }
  return errs;
}

export const validateNode = (type: NodeType, record: unknown): string[] => {
  const schema = NODE_SCHEMAS[type];
  if (!schema) return [`unknown node type ${type}`];
  return validate(schema, record);
};
