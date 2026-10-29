export interface Env {
  DB: D1Database;
  NODE_ID: string;
  NODE_NAME: string;
  OPERATOR_NAME: string;
  OPERATOR_URL: string;
  NODE_LAYER: string;
  NODE_AUTH: "none" | "optional" | "required";
  PUBLIC_URL?: string;
}

export const SCHEMA_VERSION = "1.1.0";

/** Capabilities this template implements. `venues` is added at runtime when the
 *  node actually holds Venue records. */
export const BASE_CAPABILITIES = ["films.search", "films.graph", "films.resolve", "mcp"] as const;
