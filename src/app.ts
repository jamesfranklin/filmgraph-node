/** FilmGraph node — the Hono app, host-neutral.
 *
 *  REST per docs/node-contract.md plus the fixed MCP tool set at /mcp. The
 *  manifest and schema paths are always open; everything else honours NODE_AUTH.
 *
 *  `createApp` takes a resolver from the host's raw environment (Worker
 *  bindings, or nothing on Node/Deno) to an `Env` — node config plus a `Db`.
 *  The entries in entry-*.ts are the only files that know which host this is.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import { authenticate, requireAuth, type Principal } from "./auth";
import { type Env, SCHEMA_VERSION } from "./env";
import { ApiError, envelope, paginate } from "./envelope";
import { manifestData } from "./manifest";
import { handleMcp } from "./mcp";
import { Repo } from "./repo";

type Vars = { env: Env; principal: Principal | null; repo: Repo };
type App = Hono<{ Variables: Vars }>;
type Ctx = Context<{ Variables: Vars }>;

const OPEN_PATHS = new Set(["/", "/.well-known/filmgraph", "/schema/version"]);

export function createApp(resolve: (raw: unknown) => Env): App {
const app: App = new Hono<{ Variables: Vars }>();

app.onError((e, c) => {
  if (e instanceof ApiError) return c.json(e.body(), e.status as 400);
  console.error(e);
  return c.json({ schema_version: SCHEMA_VERSION, error: "internal_error", detail: "Unexpected error" }, 500);
});
app.notFound((c) => c.json({ schema_version: SCHEMA_VERSION, error: "not_found", detail: `No route ${c.req.path}` }, 404));

// Auth: resolve the key (401 if present and bad), gate non-open paths when required.
app.use("*", async (c, next) => {
  const env = resolve(c.env);
  c.set("env", env);
  const principal = await authenticate(env, c.req.raw);
  if (!OPEN_PATHS.has(c.req.path)) requireAuth(env, principal);
  c.set("principal", principal);
  c.set("repo", new Repo(env, principal));
  await next();
});

const origin = (c: Ctx) => c.get("env").PUBLIC_URL || new URL(c.req.url).origin;
const page = (c: Context) => ({ page: Number(c.req.query("page") ?? 1) || 1, limit: Number(c.req.query("limit") ?? 20) || 20 });

// --- Meta --------------------------------------------------------------------
app.get("/", (c) => c.json(envelope({ status: "ok", service: "FilmGraph node", node_id: c.get("env").NODE_ID })));
app.get("/.well-known/filmgraph", async (c) => c.json(envelope(await manifestData(c.get("env"), c.get("repo"), origin(c)))));
app.get("/schema/version", (c) => c.json(envelope(SCHEMA_VERSION)));

// --- Films -------------------------------------------------------------------
app.get("/films/search", async (c) => {
  const q = c.req.query("q");
  if (!q) throw new ApiError("bad_request", "q is required");
  const { page: p, limit } = page(c);
  return c.json(paginate(await c.get("repo").searchFilms(q, 200), p, limit));
});

const EXT = ["tmdb", "imdb", "letterboxd", "wikidata", "eidr"];
app.get("/films/resolve", async (c) => {
  const ext: Record<string, string> = {};
  for (const k of EXT) {
    const v = c.req.query(k);
    if (v) ext[k] = v;
  }
  const title = c.req.query("title");
  const yearRaw = c.req.query("year");
  const year = yearRaw ? Number(yearRaw) : undefined;
  if (yearRaw && !Number.isInteger(year)) throw new ApiError("bad_request", "year must be an integer");
  if (!Object.keys(ext).length && !(title && year)) {
    throw new ApiError("bad_request", "Supply title and year, or at least one external id");
  }
  return c.json(envelope({ items: await c.get("repo").resolveFilm(title, year, ext) }));
});

const filmOr404 = async (c: Ctx) => {
  const ref = c.req.param("ref")!;
  const film = await c.get("repo").resolveRef(ref);
  if (!film) throw new ApiError("not_found", `Film ${ref} not found`);
  return film;
};

app.get("/films/:ref", async (c) => c.json(envelope(await filmOr404(c))));

app.get("/films/:ref/graph", async (c) => {
  const film = await filmOr404(c);
  const body = await c.get("repo").filmGraph(film);
  return c.json(envelope({ node: c.get("env").NODE_ID, ...body, generated_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z") }));
});

// v1 per-edge views, derived from the composite so they can't disagree with it.
const edgeView = (types: string[]) => async (c: Ctx) => {
  const film = await filmOr404(c);
  const { edges } = await c.get("repo").filmGraph(film);
  const items = types.flatMap((t) => (edges[t] ?? []).map((e) => e.target));
  const { page: p, limit } = page(c);
  return c.json(paginate(items, p, limit));
};
app.get("/films/:ref/festivals", edgeView(["SCREENED_AT"]));
app.get("/films/:ref/awards", edgeView(["NOMINATED_FOR", "WON"]));
app.get("/films/:ref/distributors", edgeView(["DISTRIBUTED_BY"]));
app.get("/films/:ref/similar", edgeView(["SIMILAR_TO"]));

// --- Venues (served when the node holds Venue records) -----------------------
app.get("/venues/search", async (c) => {
  const q = c.req.query("q");
  if (!q) throw new ApiError("bad_request", "q is required");
  const { page: p, limit } = page(c);
  return c.json(paginate(await c.get("repo").searchNodes("Venue", q, c.req.query("country"), 200), p, limit));
});
app.get("/venues/:id", async (c) => {
  const v = await c.get("repo").getNode("Venue", c.req.param("id"));
  if (!v) throw new ApiError("not_found", `Venue ${c.req.param("id")} not found`);
  return c.json(envelope(v));
});
app.get("/venues/:id/films", async (c) => {
  const v = await c.get("repo").getNode("Venue", c.req.param("id"));
  if (!v) throw new ApiError("not_found", `Venue ${c.req.param("id")} not found`);
  const { page: p, limit } = page(c);
  return c.json(paginate(await c.get("repo").filmsForNode(v.id), p, limit));
});

// --- MCP ---------------------------------------------------------------------
app.all("/mcp", (c) => handleMcp(c.get("env"), c.get("repo"), c.req.raw));

return app;
}
