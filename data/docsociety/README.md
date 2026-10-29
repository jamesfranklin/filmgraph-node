# Doc Society node — data intake

Deployment target: `filmgraph.docsociety.org` (`[env.docsociety]` in `wrangler.toml`).

`intake/` holds the CSV tabs Doc Society fills in — one row per film, org,
festival, venue, distributor, and one row per relationship. The single example
row in each file shows the shape; replace it.

```bash
npm run from-sheet -- data/docsociety/intake data/docsociety   # CSV → JSONL
npm run load -- data/docsociety --env docsociety --remote      # validate + load
```

## What Doc Society needs to decide per film

- **year** — first public screening (festival premiere), not copyright or TMDB.
- **external ids** — TMDB/IMDb where they exist; many docs won't have them and
  that's fine. The slug (`title-year`) is what other nodes match on.
- **which relationships** — at minimum `FUNDED` (Doc Society → film, with the
  fund) and `SCREENED_AT` (film → festival, with year and premiere status).
  Distributors and venues are optional and can come later.

Column reference is in the header of `scripts/from-sheet.ts`. Enum values
(festival `tier`, `festival_type`, org `type`, edge `section`,
`premiere_status`, `funding_type`) are fixed by the FilmGraph schema; the
loader rejects anything else and says which line.
