/** Film identity helpers — mirrors filmgraph/engine/ingest/ids.py in the
 *  reference repo. See docs/node-contract.md#film-identity. */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PREFIXED_RE = /^([a-z]+):(.+)$/;

export function filmSlug(title: string, year: number, suffix?: number): string {
  let t = title.replace(/&/g, " and ").replace(/['’]/g, "");
  t = t.normalize("NFKD").replace(/[̀-ͯ]/g, "");
  // eslint-disable-next-line no-control-regex -- deliberately strip everything outside ASCII
  t = t.replace(/[^\x00-\x7F]/g, "");
  t = t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!t) throw new Error("title produced an empty slug");
  let slug = `${t}-${Math.trunc(year)}`;
  if (suffix !== undefined) {
    if (suffix < 2) throw new Error("collision suffix starts at 2");
    slug += `-${suffix}`;
  }
  return slug;
}

export type FilmRef = { kind: "uuid" | "slug"; value: string } | { kind: "external"; system: string; value: string };

export function parseFilmRef(ref: string): FilmRef {
  ref = ref.trim();
  if (UUID_RE.test(ref)) return { kind: "uuid", value: ref.toLowerCase() };
  const m = PREFIXED_RE.exec(ref);
  if (m && m[1] !== "http" && m[1] !== "https") return { kind: "external", system: m[1], value: m[2] };
  return { kind: "slug", value: ref.toLowerCase() };
}

/** Strip the trailing -<year>[-<n>] from a slug, returning [base, year]. */
export function splitSlug(slug: string): [string, number] | null {
  const m = /^(.*)-(\d{4})(?:-\d+)?$/.exec(slug);
  return m ? [m[1], Number(m[2])] : null;
}
