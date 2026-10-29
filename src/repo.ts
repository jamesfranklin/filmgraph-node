/** D1 data access. Everything the REST routes and MCP tools need, in one place,
 *  so the two surfaces cannot drift. */

import type { Env } from "./env";
import type { Principal } from "./auth";
import { inScope } from "./auth";
import { filmSlug, parseFilmRef, splitSlug } from "./slug";

export type Film = Record<string, unknown> & { id: string; slug: string; title: string; year: number };
export type Node = Record<string, unknown> & { id: string };

interface FilmRow {
  id: string;
  doc: string;
}

const parseFilm = (row: FilmRow | null): Film | null => (row ? (JSON.parse(row.doc) as Film) : null);

export class Repo {
  constructor(private env: Env, private principal: Principal | null) {}

  private get db() {
    return this.env.DB;
  }

  /** Scope filter: a film outside the key's scope does not exist (404, not 403). */
  private visible(film: Film | null): Film | null {
    return film && inScope(this.principal, film.id) ? film : null;
  }

  // --- Films ------------------------------------------------------------------

  async resolveRef(ref: string): Promise<Film | null> {
    const r = parseFilmRef(ref);
    let row: FilmRow | null = null;
    if (r.kind === "uuid") {
      row = await this.db.prepare("SELECT id, doc FROM films WHERE id = ?1").bind(r.value).first<FilmRow>();
    } else if (r.kind === "slug") {
      row = await this.db.prepare("SELECT id, doc FROM films WHERE slug = ?1").bind(r.value).first<FilmRow>();
    } else if (r.kind === "external") {
      row = await this.db
        .prepare(
          "SELECT f.id, f.doc FROM film_external_ids x JOIN films f ON f.id = x.film_id WHERE x.system = ?1 AND x.value = ?2",
        )
        .bind(r.system, r.value)
        .first<FilmRow>();
    }
    return this.visible(parseFilm(row));
  }

  async searchFilms(q: string, limit = 50): Promise<Film[]> {
    const like = `%${q.toLowerCase().replace(/[%_]/g, "")}%`;
    const { results } = await this.db
      .prepare("SELECT id, doc FROM films WHERE title_lc LIKE ?1 ORDER BY year DESC, title_lc LIMIT ?2")
      .bind(like, Math.min(limit, 200))
      .all<FilmRow>();
    return results.map((r) => parseFilm(r)!).filter((f) => inScope(this.principal, f.id));
  }

  async filmCount(): Promise<number> {
    const row = await this.db.prepare("SELECT COUNT(*) AS n FROM films").first<{ n: number }>();
    return row?.n ?? 0;
  }

  /** docs/node-contract.md#resolution */
  async resolveFilm(
    title: string | undefined,
    year: number | undefined,
    externalIds: Record<string, string>,
  ): Promise<Array<{ film: Film; confidence: number; matched_on: string }>> {
    const out: Array<{ film: Film; confidence: number; matched_on: string }> = [];
    const seen = new Set<string>();
    const add = (film: Film | null, confidence: number, matched_on: string) => {
      if (!film || seen.has(film.id)) return;
      seen.add(film.id);
      out.push({ film, confidence, matched_on });
    };
    for (const [system, value] of Object.entries(externalIds)) {
      add(await this.resolveRef(`${system}:${value}`), 1.0, `external_ids.${system}`);
    }
    if (title && year) {
      let slug: string | null = null;
      try {
        slug = filmSlug(title, year);
      } catch {
        slug = null;
      }
      if (slug) {
        add(await this.resolveRef(slug), 0.8, "slug");
        // Same title, same year, different film: slug-2, slug-3, ... Surface them
        // so the consumer can disambiguate rather than silently taking the first.
        const { results } = await this.db
          .prepare("SELECT id, doc FROM films WHERE slug GLOB ?1 ORDER BY slug")
          .bind(`${slug}-[0-9]*`)
          .all<FilmRow>();
        for (const r of results) add(this.visible(parseFilm(r)), 0.7, "slug_collision");
        const base = splitSlug(slug)![0];
        for (const dy of [-1, 1]) add(await this.resolveRef(`${base}-${year + dy}`), 0.6, "slug_year_adjacent");
      }
    }
    return out;
  }

  // --- Composite document -----------------------------------------------------

  async filmGraph(film: Film) {
    const { results } = await this.db
      .prepare(
        `SELECT e.id, e.type, e.from_id, e.to_id, e.props,
                CASE WHEN e.from_id = ?1 THEN e.to_id ELSE e.from_id END AS far_id
           FROM edges e
          WHERE e.from_id = ?1 OR e.to_id = ?1
          ORDER BY e.type, e.id`,
      )
      .bind(film.id)
      .all<{ id: string; type: string; from_id: string; to_id: string; props: string; far_id: string }>();

    // Fetch far nodes in one go (nodes table + films table for film↔film edges).
    const farIds = [...new Set(results.map((r) => r.far_id))];
    const far = new Map<string, Node>();
    for (let i = 0; i < farIds.length; i += 50) {
      const chunk = farIds.slice(i, i + 50);
      const marks = chunk.map((_, j) => `?${j + 1}`).join(",");
      const [n, f] = await Promise.all([
        this.db.prepare(`SELECT id, type, doc FROM nodes WHERE id IN (${marks})`).bind(...chunk).all<{ id: string; type: string; doc: string }>(),
        this.db.prepare(`SELECT id, doc FROM films WHERE id IN (${marks})`).bind(...chunk).all<FilmRow>(),
      ]);
      for (const r of n.results) far.set(r.id, { ...(JSON.parse(r.doc) as Node), _type: r.type });
      for (const r of f.results) far.set(r.id, { ...(JSON.parse(r.doc) as Node), _type: "Film" });
    }

    const edges: Record<string, Array<{ edge: Record<string, unknown>; target: Node }>> = {};
    for (const r of results) {
      const target = far.get(r.far_id);
      if (!target) continue; // dangling edge; loader should have rejected it
      if (target._type === "Film" && !inScope(this.principal, target.id)) continue;
      const edge: Record<string, unknown> = { ...(JSON.parse(r.props) as Record<string, unknown>) };
      if (r.to_id === film.id) edge.direction = "in";
      (edges[r.type] ??= []).push({ edge, target });
    }
    return { film, edges };
  }

  // --- Manifest support -------------------------------------------------------

  async servedTypes(): Promise<{ node_types: string[]; edge_types: string[] }> {
    const [n, e, films] = await Promise.all([
      this.db.prepare("SELECT DISTINCT type FROM nodes ORDER BY type").all<{ type: string }>(),
      this.db.prepare("SELECT DISTINCT type FROM edges ORDER BY type").all<{ type: string }>(),
      this.filmCount(),
    ]);
    const node_types = n.results.map((r) => r.type);
    if (films > 0 || node_types.length === 0) node_types.unshift("Film");
    return { node_types, edge_types: e.results.map((r) => r.type) };
  }

  // --- Venues (optional capability) ------------------------------------------

  async getNode(type: string, id: string): Promise<Node | null> {
    const row = await this.db
      .prepare("SELECT doc FROM nodes WHERE id = ?1 AND type = ?2")
      .bind(id, type)
      .first<{ doc: string }>();
    return row ? (JSON.parse(row.doc) as Node) : null;
  }

  async searchNodes(type: string, q: string, country?: string, limit = 50): Promise<Node[]> {
    const like = `%${q.toLowerCase().replace(/[%_]/g, "")}%`;
    const stmt = country
      ? this.db
          .prepare("SELECT doc FROM nodes WHERE type = ?1 AND name_lc LIKE ?2 AND country = ?3 ORDER BY name_lc LIMIT ?4")
          .bind(type, like, country.toUpperCase(), Math.min(limit, 200))
      : this.db
          .prepare("SELECT doc FROM nodes WHERE type = ?1 AND name_lc LIKE ?2 ORDER BY name_lc LIMIT ?3")
          .bind(type, like, Math.min(limit, 200));
    const { results } = await stmt.all<{ doc: string }>();
    return results.map((r) => JSON.parse(r.doc) as Node);
  }

  async filmsForNode(nodeId: string): Promise<Film[]> {
    const { results } = await this.db
      .prepare(
        `SELECT DISTINCT f.id, f.doc FROM edges e
           JOIN films f ON f.id = CASE WHEN e.from_id = ?1 THEN e.to_id ELSE e.from_id END
          WHERE e.from_id = ?1 OR e.to_id = ?1
          ORDER BY f.year DESC LIMIT 500`,
      )
      .bind(nodeId)
      .all<FilmRow>();
    return results.map((r) => parseFilm(r)!).filter((f) => inScope(this.principal, f.id));
  }
}
