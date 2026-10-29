/** The whole node, end to end, on libSQL in memory — the same app the Worker
 *  serves over D1. Proves the host-neutral split: nothing here is Cloudflare. */
import { readFileSync } from "node:fs";
import { createClient } from "@libsql/client";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { libsqlDb } from "../src/db";
import { configFrom, type Env } from "../src/env";
import { sha256Hex } from "../src/auth";

const KEY = "fg_test_key";
let env: Env;
let app: ReturnType<typeof createApp>;
const get = (path: string, key: string | null = KEY) =>
  app.request(`http://node.test${path}`, { headers: key ? { "x-api-key": key } : {} });
const json = async (r: Response) => (await r.json()) as { data: Record<string, unknown> & Record<string, any>; error?: string };

beforeAll(async () => {
  const db = libsqlDb(createClient({ url: ":memory:" }));
  await db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  await db.run("INSERT INTO api_keys (key_hash, label, scope) VALUES (?1, 'test', NULL)", await sha256Hex(KEY));
  const film = { id: "7d2b1c3e-5a4f-5b6c-8d9e-0f1a2b3c4d5e", slug: "parasite-2019", title: "Parasite", year: 2019, external_ids: { tmdb: 496243 } };
  await db.run("INSERT INTO films (id, slug, title, title_lc, year, doc) VALUES (?1, ?2, ?3, ?4, ?5, ?6)", film.id, film.slug, film.title, "parasite", 2019, JSON.stringify(film));
  await db.run("INSERT INTO film_external_ids (system, value, film_id) VALUES ('tmdb', '496243', ?1)", film.id);
  const fest = { id: "0b1e7f3a-1111-4aaa-8bbb-000000000002", name: "Festival de Cannes", city: "Cannes", country: "FR", tier: "a_list", festival_type: "film" };
  await db.run("INSERT INTO nodes (id, type, name, name_lc, country, doc) VALUES (?1, 'Festival', ?2, ?3, 'FR', ?4)", fest.id, fest.name, "festival de cannes", JSON.stringify(fest));
  await db.run("INSERT INTO edges (id, type, from_id, to_id, props) VALUES ('e1', 'SCREENED_AT', ?1, ?2, ?3)", film.id, fest.id, JSON.stringify({ year: 2019, section: "competition" }));
  env = { ...configFrom({ NODE_ID: "test", NODE_NAME: "Test node", OPERATOR_NAME: "Test", OPERATOR_URL: "https://example.org", NODE_AUTH: "required" }), db };
  app = createApp(() => env);
});

describe("app on libSQL", () => {
  it("manifest is open and counts the films", async () => {
    const r = await get("/.well-known/filmgraph", null);
    expect(r.status).toBe(200);
    expect((await json(r)).data).toMatchObject({ node_id: "test", film_count: 1, node_types: ["Film", "Festival"], edge_types: ["SCREENED_AT"] });
  });
  it("films need a key; 401 not 403", async () => {
    expect((await get("/films/parasite-2019", null)).status).toBe(401);
    expect((await get("/films/parasite-2019", "fg_wrong")).status).toBe(401);
  });
  it("resolves slug, tmdb: and uuid to the same film and builds the graph", async () => {
    for (const ref of ["parasite-2019", "tmdb:496243", "7d2b1c3e-5a4f-5b6c-8d9e-0f1a2b3c4d5e"]) {
      const d = (await json(await get(`/films/${ref}`))).data;
      expect(d.slug, ref).toBe("parasite-2019");
    }
    const g = (await json(await get("/films/parasite-2019/graph"))).data;
    expect(g.edges.SCREENED_AT).toHaveLength(1);
    expect(g.edges.SCREENED_AT[0].target.name).toBe("Festival de Cannes");
    expect((await get("/films/nope-1900")).status).toBe(404);
  });
  it("search and resolve", async () => {
    expect((await json(await get("/films/search?q=para"))).data.items).toHaveLength(1);
    const items = (await json(await get("/films/resolve?title=Parasite&year=2020"))).data.items;
    expect(items[0]).toMatchObject({ confidence: 0.6, matched_on: "slug_year_adjacent" });
  });
  it("mcp answers tools/list", async () => {
    const r = await app.request("http://node.test/mcp", {
      method: "POST",
      headers: { "x-api-key": KEY, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const body = (await r.json()) as { result: { tools: { name: string }[] } };
    expect(body.result.tools.map((t) => t.name)).toEqual(expect.arrayContaining(["node_info", "search_films", "resolve_film", "get_film"]));
  });
});
