/**
 * Turn a spreadsheet export into loader-ready JSONL.
 *
 *   npm run from-sheet -- data/example/intake data/example
 *
 * Reads CSVs from the intake directory (export each tab of the intake sheet
 * as CSV with these exact names) and writes films.jsonl / nodes.jsonl /
 * edges.jsonl to the output directory. Run `npm run load -- <out>` after.
 *
 *   films.csv      title, year, title_en, original_title, tmdb, imdb, wikidata,
 *                  letterboxd, wikidata, origin_country, language, genres,
 *                  runtime_mins, budget_tier, keywords, ref
 *                  - `ref` is YOUR handle for this film (any short unique
 *                    string) used in the other tabs; defaults to the slug.
 *                  - list columns (origin_country, genres, keywords) are
 *                    separated by `;` or `|`.
 *   organisations.csv  ref, name, type, territory, website
 *   festivals.csv      ref, name, city, country, tier, festival_type, website, founded_year
 *   venues.csv         ref, name, city, country, address, website, is_independent
 *   distributors.csv   ref, name, territory, website
 *   edges.csv          type, from, to, then any edge properties as columns
 *                  - from/to are refs from the tabs above (or a film slug / tmdb:123)
 *                  - empty cells are omitted; numeric-looking cells become numbers
 *
 * Column names are case-insensitive. Unknown columns are reported and ignored.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { filmSlug } from "../src/slug";

const [inDir, outDir] = process.argv.slice(2);
if (!inDir || !outDir) {
  console.error("usage: from-sheet.ts <intake-dir> <out-dir>");
  process.exit(2);
}

// --- tiny CSV parser (RFC 4180: quotes, escaped quotes, newlines in quotes) ---
function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') inQ = false;
      else cell += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      cell = "";
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== "")) rows.push(row);
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));
  return rows.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? "").trim()])));
}

const read = (name: string) => {
  const p = join(inDir, name);
  return existsSync(p) ? parseCsv(readFileSync(p, "utf8").replace(/^﻿/, "")) : null;
};
const list = (v: string) => v.split(/[;|]/).map((s) => s.trim()).filter(Boolean);
const num = (v: string) => (v !== "" && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : undefined);
const bool = (v: string) => (/^(true|yes|y|1)$/i.test(v) ? true : /^(false|no|n|0)$/i.test(v) ? false : undefined);
const warn: string[] = [];

// --- Films -------------------------------------------------------------------
const refToId = new Map<string, string>();
const films: Record<string, unknown>[] = [];
const filmRows = read("films.csv") ?? [];
const KNOWN_FILM = new Set(["ref", "title", "year", "title_en", "original_title", "tmdb", "imdb", "letterboxd", "wikidata", "eidr", "origin_country", "language", "genres", "runtime_mins", "budget_tier", "keywords", "id"]);
for (const [i, r] of filmRows.entries()) {
  const where = `films.csv:${i + 2}`;
  for (const k of Object.keys(r)) if (!KNOWN_FILM.has(k) && r[k]) warn.push(`${where}: ignoring column '${k}'`);
  if (!r.title || !num(r.year)) {
    warn.push(`${where}: title and year required — skipped`);
    continue;
  }
  const f: Record<string, unknown> = { id: r.id || randomUUID(), title: r.title, year: num(r.year) };
  if (r.title_en !== undefined && r.title_en !== "") f.title_en = r.title_en.toLowerCase() === "null" ? null : r.title_en;
  if (r.original_title) f.original_title = r.original_title;
  const ext: Record<string, string | number> = {};
  for (const k of ["tmdb"]) if (num(r[k]) !== undefined) ext[k] = num(r[k])!;
  for (const k of ["imdb", "letterboxd", "wikidata", "eidr"]) if (r[k]) ext[k] = r[k];
  if (Object.keys(ext).length) f.external_ids = ext;
  if (r.origin_country) f.origin_country = list(r.origin_country).map((c) => c.toUpperCase());
  if (r.language) f.language = r.language;
  if (r.genres) f.genres = list(r.genres);
  if (r.keywords) f.keywords = list(r.keywords);
  if (num(r.runtime_mins) !== undefined) f.runtime_mins = num(r.runtime_mins);
  if (r.budget_tier) f.budget_tier = r.budget_tier.toLowerCase();
  const slug = filmSlug(r.title, f.year as number);
  refToId.set((r.ref || slug).toLowerCase(), f.id as string);
  refToId.set(slug, f.id as string);
  films.push(f);
}

// --- Other nodes ---------------------------------------------------------------
const nodes: Record<string, unknown>[] = [];
const sheets: Array<[string, string, (r: Record<string, string>) => Record<string, unknown>]> = [
  ["organisations.csv", "Organisation", (r) => ({ name: r.name, type: r.type, territory: r.territory ? list(r.territory).map((c) => c.toUpperCase()) : undefined, website: r.website || undefined })],
  ["festivals.csv", "Festival", (r) => ({ name: r.name, city: r.city, country: r.country?.toUpperCase(), tier: r.tier, festival_type: r.festival_type, website: r.website || undefined, founded_year: num(r.founded_year) })],
  ["venues.csv", "Venue", (r) => ({ name: r.name, city: r.city, country: r.country?.toUpperCase(), address: r.address || undefined, website: r.website || undefined, is_independent: bool(r.is_independent) })],
  ["distributors.csv", "Distributor", (r) => ({ name: r.name, territory: r.territory ? list(r.territory).map((c) => c.toUpperCase()) : undefined, website: r.website || undefined })],
];
for (const [file, type, map] of sheets) {
  for (const [i, r] of (read(file) ?? []).entries()) {
    const where = `${file}:${i + 2}`;
    if (!r.name) {
      warn.push(`${where}: name required — skipped`);
      continue;
    }
    const id = r.id || randomUUID();
    const node = Object.fromEntries(Object.entries({ _type: type, id, ...map(r) }).filter(([, v]) => v !== undefined && v !== ""));
    const ref = (r.ref || r.name).toLowerCase();
    if (refToId.has(ref)) warn.push(`${where}: ref '${ref}' already used — edges will hit the first one`);
    else refToId.set(ref, id);
    nodes.push(node);
  }
}

// --- Edges ---------------------------------------------------------------------
const edges: Record<string, unknown>[] = [];
for (const [i, r] of (read("edges.csv") ?? []).entries()) {
  const where = `edges.csv:${i + 2}`;
  const { type, from, to, ...rest } = r;
  if (!type || !from || !to) {
    warn.push(`${where}: type, from, to required — skipped`);
    continue;
  }
  const resolve = (v: string) => refToId.get(v.toLowerCase()) ?? v; // fall through to slug / tmdb:… for the loader
  const edge: Record<string, unknown> = { type: type.toUpperCase().replace(/\s+/g, "_"), from: resolve(from), to: resolve(to) };
  for (const [k, v] of Object.entries(rest)) {
    if (v === "") continue;
    edge[k] = num(v) ?? bool(v) ?? v;
  }
  edges.push(edge);
}

mkdirSync(outDir, { recursive: true });
const dump = (name: string, rows: unknown[]) => writeFileSync(join(outDir, name), rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
dump("films.jsonl", films);
dump("nodes.jsonl", nodes);
dump("edges.jsonl", edges);
for (const w of warn) console.warn("warning:", w);
console.log(`${films.length} films, ${nodes.length} nodes, ${edges.length} edges → ${outDir}/ (now run: npm run load -- ${outDir})`);
