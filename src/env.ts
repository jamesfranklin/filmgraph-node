import type { Db } from "./db";

/** Who this node is. Set from Worker vars, process env, or a config file —
 *  see the entries in src/entry-*.ts. */
export interface NodeConfig {
  NODE_ID: string;
  NODE_NAME: string;
  OPERATOR_NAME: string;
  OPERATOR_URL: string;
  NODE_LAYER: string;
  NODE_AUTH: "none" | "optional" | "required";
  PUBLIC_URL?: string;
}

/** What every request handler gets: the node's identity plus its database.
 *  Host-neutral — nothing here knows about Cloudflare, Node or Deno. */
export interface Env extends NodeConfig {
  db: Db;
}

const AUTH = new Set(["none", "optional", "required"]);

/** Build a NodeConfig from a flat string map (Worker vars, process.env, Deno.env). */
export function configFrom(src: Record<string, string | undefined>): NodeConfig {
  const need = (k: keyof NodeConfig) => {
    const v = src[k];
    if (!v) throw new Error(`FilmGraph node: ${k} is not set`);
    return v;
  };
  const auth = src.NODE_AUTH ?? "required";
  if (!AUTH.has(auth)) throw new Error(`FilmGraph node: NODE_AUTH must be none|optional|required, got ${auth}`);
  return {
    NODE_ID: need("NODE_ID"),
    NODE_NAME: need("NODE_NAME"),
    OPERATOR_NAME: need("OPERATOR_NAME"),
    OPERATOR_URL: need("OPERATOR_URL"),
    NODE_LAYER: src.NODE_LAYER ?? "1",
    NODE_AUTH: auth as NodeConfig["NODE_AUTH"],
    ...(src.PUBLIC_URL ? { PUBLIC_URL: src.PUBLIC_URL } : {}),
  };
}

export const SCHEMA_VERSION = "1.1.0";

/** Capabilities this template implements. `venues` is added at runtime when the
 *  node actually holds Venue records. */
export const BASE_CAPABILITIES = ["films.search", "films.graph", "films.resolve", "mcp"] as const;
