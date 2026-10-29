/** Node.js entry (also the shape for any container host — Scaleway, Koyeb,
 *  Fly, a VPS): node config from process.env, storage from libSQL.
 *
 *    FILMGRAPH_DB=file:./node.db  NODE_ID=… npm run start
 *    FILMGRAPH_DB=libsql://…  FILMGRAPH_DB_TOKEN=…   (Turso / any libSQL server)
 */
import { serve } from "@hono/node-server";
import { createClient } from "@libsql/client";
import { createApp } from "./app";
import { libsqlDb } from "./db";
import { configFrom } from "./env";

const url = process.env.FILMGRAPH_DB ?? "file:./node.db";
const env = { ...configFrom(process.env), db: libsqlDb(createClient({ url, authToken: process.env.FILMGRAPH_DB_TOKEN })) };
const app = createApp(() => env);
const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port }, () => console.log(`FilmGraph node ${env.NODE_ID} on http://localhost:${port} (${url})`));
