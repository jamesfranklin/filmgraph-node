/** Deno entry — also what Bunny Edge Scripting and Deno Deploy run. Config
 *  from Deno.env, storage from libSQL over HTTP (Turso, Bunny Database, or any
 *  libSQL server): FILMGRAPH_DB=libsql://… FILMGRAPH_DB_TOKEN=…
 *
 *  The `npm:` specifier is Deno's; on a host that bundles for you, import
 *  "@libsql/client/web" instead. */
// @ts-nocheck — Deno globals and npm: specifiers are not in this project's tsconfig.
import { createClient } from "npm:@libsql/client/web";
import { createApp } from "./app.ts";
import { libsqlDb } from "./db.ts";
import { configFrom } from "./env.ts";

const env = {
  ...configFrom(Deno.env.toObject()),
  db: libsqlDb(createClient({ url: Deno.env.get("FILMGRAPH_DB"), authToken: Deno.env.get("FILMGRAPH_DB_TOKEN") })),
};
Deno.serve(createApp(() => env).fetch);
