# filmgraph-node

A ready-to-deploy **FilmGraph node**: Cloudflare Worker + D1, serving the
[FilmGraph node contract](https://github.com/jamesfranklin/FilmGraph/blob/main/docs/node-contract.md)
over REST and MCP. Load your films as JSONL, issue keys, deploy. No Neo4j, no
servers.

Use it when you hold a bounded, slowly-changing set of films — a funder's
slate, a distributor's catalogue, a festival's programme — and want agents and
apps to reach it the same way they reach every other FilmGraph node. If your
data lives in a live system with its own API, you probably want a thin wrapper
in that system's stack instead; the contract is the same either way.

## What you get

| Surface | Path | Notes |
| --- | --- | --- |
| Manifest | `GET /.well-known/filmgraph` | Always open. Node/edge types derived from your data. |
| Films | `GET /films/{ref}` · `/films/{ref}/graph` · `/films/search?q=` · `/films/resolve?title=&year=` | `ref` = UUID, slug (`parasite-2019`) or `tmdb:496243` |
| Venues | `/venues/search` · `/venues/{id}` · `/venues/{id}/films` | Only advertised when you load Venue nodes |
| MCP | `POST /mcp` (Streamable HTTP, stateless) | `node_info` `search_films` `resolve_film` `get_film` `search_venues` `get_venue` |
| Auth | `X-API-Key` or `Authorization: Bearer` | Per-consumer keys, hashed at rest, optionally scoped to a film list |

REST and MCP share one data layer (`src/repo.ts`), so they cannot disagree.

## Deploy in ten minutes

```bash
git clone https://github.com/jamesfranklin/filmgraph-node my-node && cd my-node
npm install

# 1. Create the database and point wrangler.toml at it
npx wrangler d1 create filmgraph          # paste database_id into wrangler.toml
npm run db:init:remote                     # creates tables

# 2. Identity — edit [vars] in wrangler.toml
#    NODE_ID, NODE_NAME, OPERATOR_NAME, OPERATOR_URL, NODE_LAYER, NODE_AUTH, PUBLIC_URL

# 3. Data — put films.jsonl (+ nodes.jsonl, edges.jsonl) in a folder, then
npm run load -- data/my-films --remote     # validates everything first; refuses on any error

# 4. Keys — one per consumer
npm run issue-key -- --label "Our staff" --remote
npm run issue-key -- --label "Partner app" --scope your-film-2023,other-film-2021 --remote

# 5. Ship
npm run deploy
```

Then prove it:

```bash
git clone https://github.com/jamesfranklin/FilmGraph && cd FilmGraph && pip install -r requirements.txt
FILMGRAPH_NODE_URL=https://filmgraph.example.org FILMGRAPH_NODE_KEY=fg_… pytest conformance/
```

Custom domain: add a `routes = [{ pattern = "filmgraph.example.org", custom_domain = true }]`
line (see the commented `[env.docsociety]` block in `wrangler.toml` for a
complete second-environment example; deploy it with `npm run deploy -- --env docsociety`).

## Local development

```bash
npm run db:init                 # local D1
npm run load -- data/example    # 5 films, 4 nodes, 5 edges
npm run issue-key -- --label dev
npm run dev                     # http://127.0.0.1:8787
```

`npm test` runs the unit tests; typecheck with `npm run typecheck`.

## Data format

Three JSONL files in one directory. Every record is validated against the
FilmGraph schema (`schema/v1/`, vendored from the FilmGraph repo) **before**
anything is written; one bad line fails the whole load, with line numbers.

### `films.jsonl` — Film nodes

```json
{"title": "Your Fat Friend", "year": 2023, "external_ids": {"tmdb": 1091860}, "origin_country": ["GB"], "genres": ["Documentary"]}
```

- `title` + `year` required. `year` is the year of **first public screening**
  (festival premiere counts) — not copyright, not theatrical, not TMDB's.
- `id` (UUID) and `slug` are generated if absent. Keep the file with the
  generated ids if you want stable ids across reloads — or supply your own.
- `slug` collisions within your dataset get `-2`, `-3`… automatically.
- `tmdb_id` / `imdb_id` are folded into `external_ids` for you.
- A film with no English title: supply the romanised original as `title` and
  set `"title_en": null`.

### `nodes.jsonl` — everything that isn't a film

```json
{"_type": "Festival", "id": "…", "name": "Sheffield DocFest", "city": "Sheffield", "country": "GB", "tier": "major", "festival_type": "documentary"}
{"_type": "Venue", "id": "…", "name": "Watershed", "city": "Bristol", "country": "GB"}
```

`_type` is the schema node type. Supply `id`s so edges can reference them.

### `edges.jsonl`

```json
{"type": "SCREENED_AT", "from": "your-fat-friend-2023", "to": "<festival id>", "year": 2023, "premiere_status": "world"}
{"type": "FUNDED", "from": "<organisation id>", "to": "tmdb:1091860", "funding_type": "production"}
```

`from` / `to` accept a node id or any film reference. Direction and
properties are checked against the edge schema (`FUNDED` goes Organisation →
Film; `SCREENED_AT` requires `year`; and so on).

Loading **replaces** films, nodes and edges wholesale. Keys survive.

## Keys and scope

Keys are stored as SHA-256; the plaintext is shown once at issue time. A key
with `--scope` sees only those films: out-of-scope films 404, searches and
venue listings are filtered, and `/graph` omits film→film edges to films
outside scope. That is how one node serves several partners without leaking
across them.

`npm run issue-key -- --list` / `--revoke <key>`.

## Layers

Set `NODE_LAYER = "2"` if you load reserved edge types (`EXHIBITED_AT`
showtimes, `SHAPE_MATCHES`) or anything else that must stay behind keys. The
shapes are identical to a public node; only the manifest and your key policy
differ. `NODE_AUTH = "required"` is the default for this template; set
`"optional"` for a public node where a key only lifts rate limits.

## Keeping up with the contract

The MCP tool set and REST paths are fixed by the contract. When the contract
gains a tool or capability, it lands here as a version bump; the manifest's
`capabilities` list tells consumers what a given deployment supports, so old
deployments keep working. Re-copy `schema/v1/*.json` from the FilmGraph repo
when the schema changes.

## Layout

```
src/index.ts    routes (Hono)           scripts/load.ts       JSONL → D1, validated
src/repo.ts     all data access         scripts/issue-key.ts  key issue / revoke / list
src/mcp.ts      JSON-RPC tool server    scripts/validate.ts   schema-subset validator
src/auth.ts     keys and scope          schema/v1/            vendored FilmGraph schema
src/manifest.ts /.well-known/filmgraph  data/example/         tiny dataset for dev
src/slug.ts     slug + ref parsing      test/                 unit tests (vitest)
```

Apache 2.0.
