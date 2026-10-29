/**
 * Load a FilmGraph dataset into D1.
 *
 *   npm run load -- data/example            # local D1 (wrangler dev)
 *   npm run load -- data/example --remote   # production D1
 *   npm run load -- data/example --sql out.sql   # just write the SQL
 *
 * Reads from the directory:
 *   films.jsonl   — Film nodes. `slug` is derived if missing (collision suffix
 *                   assigned per this dataset). `tmdb_id`/`imdb_id` are folded
 *                   into `external_ids`.
 *   nodes.jsonl   — every other node, each line { "_type": "Venue", ...node }
 *   edges.jsonl   — { "type": "SCREENED_AT", "from": "<id>", "to": "<id>", ...props }
 *                   `from`/`to` may be a film reference (slug / tmdb:123) or an id.
 *
 * Validates every Film and node against the FilmGraph schema (schema/ copied
 * from the FilmGraph repo) before writing anything. Replaces the dataset
 * wholesale: films, nodes and edges are truncated first; api_keys are kept.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { filmSlug, parseFilmRef } from "../src/slug";
import { EDGE_SCHEMAS, validate, validateNode, type NodeType } from "./validate";

const args: string[] = process.argv.slice(2);
const dir = args.find((a: string) => !a.startsWith("--"));
if (!dir) {
  console.error("usage: load.ts <data-dir> [--remote] [--sql out.sql] [--env name]");
  process.exit(2);
}
const dataDir: string = dir as string;
const remote = args.includes("--remote");
const sqlOut = args.includes("--sql") ? args[args.indexOf("--sql") + 1] : null;
const envName = args.includes("--env") ? args[args.indexOf("--env") + 1] : null;

const readJsonl = (name: string): Record<string, unknown>[] => {
  const p = join(dataDir, name);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l, i) => {
      try {
        return JSON.parse(l);
      } catch (e) {
        throw new Error(`${name}:${i + 1}: ${(e as Error).message}`);
      }
    });
};

const q = (v: unknown) => `'${String(v).replace(/'/g, "''")}'`;
const stmts: string[] = [
  "DELETE FROM edges;",
  "DELETE FROM film_external_ids;",
  "DELETE FROM films;",
  "DELETE FROM nodes;",
];
const problems: string[] = [];

// --- Films -------------------------------------------------------------------
const films = readJsonl("films.jsonl");
const slugs = new Map<string, string>(); // slug -> film id
const byRef = new Map<string, string>(); // "slug:x" | "tmdb:1" | "uuid" -> film id

for (const [i, raw] of films.entries()) {
  const f = { ...raw } as Record<string, unknown>;
  const where = `films.jsonl:${i + 1}`;
  if (typeof f.title !== "string" || !f.title) problems.push(`${where}: title required`);
  if (!Number.isInteger(f.year)) problems.push(`${where}: year (integer) required`);
  if (problems.length) continue;

  const ext: Record<string, string | number> = { ...((f.external_ids as Record<string, string | number>) ?? {}) };
  if (f.tmdb_id != null) ext.tmdb ??= Number(f.tmdb_id);
  if (f.imdb_id) ext.imdb ??= String(f.imdb_id);
  if (Object.keys(ext).length) f.external_ids = ext;

  f.id ??= randomUUID();
  if (!f.slug) {
    const base = filmSlug(f.title as string, f.year as number);
    let slug = base;
    for (let n = 2; slugs.has(slug) && slugs.get(slug) !== f.id; n++) slug = `${base}-${n}`;
    f.slug = slug;
  } else if (slugs.has(f.slug as string) && slugs.get(f.slug as string) !== f.id) {
    problems.push(`${where}: slug ${f.slug} already used by another film`);
    continue;
  }

  const errs = validateNode("Film", f);
  if (errs.length) {
    problems.push(`${where}: ${errs.join("; ")}`);
    continue;
  }

  slugs.set(f.slug as string, f.id as string);
  byRef.set(`slug:${f.slug}`, f.id as string);
  byRef.set(f.id as string, f.id as string);
  for (const [k, v] of Object.entries(ext)) byRef.set(`${k}:${v}`, f.id as string);

  stmts.push(
    `INSERT INTO films (id, slug, title, title_lc, year, doc) VALUES (${q(f.id)}, ${q(f.slug)}, ${q(f.title)}, ${q(
      (f.title as string).toLowerCase(),
    )}, ${f.year}, ${q(JSON.stringify(f))});`,
  );
  for (const [k, v] of Object.entries(ext)) {
    stmts.push(`INSERT INTO film_external_ids (system, value, film_id) VALUES (${q(k)}, ${q(v)}, ${q(f.id)});`);
  }
}

// --- Other nodes ---------------------------------------------------------------
const nodeIds = new Set<string>();
const nodeTypeOf = new Map<string, string>(); // id -> type (films included)
for (const id of byRef.values()) nodeTypeOf.set(id, "Film");
for (const [i, raw] of readJsonl("nodes.jsonl").entries()) {
  const where = `nodes.jsonl:${i + 1}`;
  const { _type, ...node } = raw as { _type?: string } & Record<string, unknown>;
  if (!_type || _type === "Film") {
    problems.push(`${where}: _type required (and Films go in films.jsonl)`);
    continue;
  }
  node.id ??= randomUUID();
  const errs = validateNode(_type as NodeType, node);
  if (errs.length) {
    problems.push(`${where}: ${_type} ${errs.join("; ")}`);
    continue;
  }
  nodeIds.add(node.id as string);
  nodeTypeOf.set(node.id as string, _type);
  stmts.push(
    `INSERT INTO nodes (id, type, name, name_lc, country, doc) VALUES (${q(node.id)}, ${q(_type)}, ${
      node.name ? q(node.name) : "NULL"
    }, ${node.name ? q(String(node.name).toLowerCase()) : "NULL"}, ${node.country ? q(node.country) : "NULL"}, ${q(
      JSON.stringify(node),
    )});`,
  );
}

// --- Edges ---------------------------------------------------------------------
const resolveEnd = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  if (nodeIds.has(v)) return v;
  const r = parseFilmRef(v);
  const key = r.kind === "external" ? `${r.system}:${r.value}` : r.kind === "uuid" ? r.value : `slug:${r.value}`;
  return byRef.get(key) ?? null;
};
for (const [i, raw] of readJsonl("edges.jsonl").entries()) {
  const where = `edges.jsonl:${i + 1}`;
  const { type, from, to, id, ...props } = raw as { type?: string; from?: unknown; to?: unknown; id?: string } & Record<string, unknown>;
  if (!type || !/^[A-Z_]+$/.test(type)) {
    problems.push(`${where}: type required (UPPER_SNAKE)`);
    continue;
  }
  const fromId = resolveEnd(from);
  const toId = resolveEnd(to);
  if (!fromId || !toId) {
    problems.push(`${where}: cannot resolve ${!fromId ? `from=${from}` : `to=${to}`}`);
    continue;
  }
  const edgeSchema = EDGE_SCHEMAS[type] as
    | { source?: string[]; target?: string[]; properties?: Parameters<typeof validate>[0] }
    | undefined;
  if (!edgeSchema) {
    problems.push(`${where}: ${type} is not a FilmGraph edge type`);
    continue;
  }
  const fromType = nodeTypeOf.get(fromId)!;
  const toType = nodeTypeOf.get(toId)!;
  if (edgeSchema.source && !edgeSchema.source.includes(fromType)) {
    problems.push(`${where}: ${type} source must be ${edgeSchema.source.join("|")}, got ${fromType}`);
    continue;
  }
  if (edgeSchema.target && !edgeSchema.target.includes(toType)) {
    problems.push(`${where}: ${type} target must be ${edgeSchema.target.join("|")}, got ${toType}`);
    continue;
  }
  if (edgeSchema.properties) {
    const errs = validate(edgeSchema.properties, props);
    if (errs.length) {
      problems.push(`${where}: ${type} ${errs.join("; ")}`);
      continue;
    }
  }
  stmts.push(
    `INSERT INTO edges (id, type, from_id, to_id, props) VALUES (${q(id ?? randomUUID())}, ${q(type)}, ${q(fromId)}, ${q(toId)}, ${q(
      JSON.stringify(props),
    )});`,
  );
}

stmts.push(
  `INSERT INTO meta (key, value) VALUES ('updated_at', ${q(new Date().toISOString().replace(/\.\d{3}Z$/, "Z"))}) ON CONFLICT(key) DO UPDATE SET value = excluded.value;`,
);

if (problems.length) {
  console.error(`Refusing to load: ${problems.length} problem(s)\n` + problems.slice(0, 50).join("\n"));
  process.exit(1);
}

const sql = stmts.join("\n") + "\n";
const target = sqlOut ?? join(process.cwd(), ".load.sql");
writeFileSync(target, sql);
console.log(`${films.length} films, ${nodeIds.size} nodes, ${stmts.filter((s) => s.startsWith("INSERT INTO edges")).length} edges → ${target}`);
if (sqlOut) process.exit(0);

const wrangler = ["d1", "execute", "filmgraph", remote ? "--remote" : "--local", `--file=${target}`, "-y"];
if (envName) wrangler.push("--env", envName);
execFileSync("npx", ["wrangler", ...wrangler], { stdio: "inherit" });
