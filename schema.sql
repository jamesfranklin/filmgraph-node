-- FilmGraph node storage. Documents are stored whole as JSON (the schema is the
-- authority on shape); columns exist only for lookup and search.

CREATE TABLE IF NOT EXISTS films (
  id        TEXT PRIMARY KEY,          -- UUID
  slug      TEXT NOT NULL UNIQUE,      -- <title>-<year>[-n]
  title     TEXT NOT NULL,
  title_lc  TEXT NOT NULL,             -- lowercase, for LIKE search
  year      INTEGER NOT NULL,
  doc       TEXT NOT NULL              -- full Film node JSON
);
CREATE INDEX IF NOT EXISTS films_title_lc ON films(title_lc);
CREATE INDEX IF NOT EXISTS films_year ON films(year);

CREATE TABLE IF NOT EXISTS film_external_ids (
  system   TEXT NOT NULL,              -- tmdb | imdb | mx | letterboxd | wikidata | eidr | ...
  value    TEXT NOT NULL,
  film_id  TEXT NOT NULL REFERENCES films(id) ON DELETE CASCADE,
  PRIMARY KEY (system, value)
);
CREATE INDEX IF NOT EXISTS film_external_ids_film ON film_external_ids(film_id);

-- Every non-Film node: Venue, Festival, Distributor, Organisation, ...
CREATE TABLE IF NOT EXISTS nodes (
  id    TEXT PRIMARY KEY,
  type  TEXT NOT NULL,
  name  TEXT,
  name_lc TEXT,
  country TEXT,
  doc   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS nodes_type ON nodes(type);
CREATE INDEX IF NOT EXISTS nodes_name_lc ON nodes(type, name_lc);

CREATE TABLE IF NOT EXISTS edges (
  id       TEXT PRIMARY KEY,
  type     TEXT NOT NULL,              -- SCREENED_AT, FUNDED, ...
  from_id  TEXT NOT NULL,
  to_id    TEXT NOT NULL,
  props    TEXT NOT NULL DEFAULT '{}'  -- edge properties JSON
);
CREATE INDEX IF NOT EXISTS edges_from ON edges(from_id, type);
CREATE INDEX IF NOT EXISTS edges_to ON edges(to_id, type);

-- One row per consumer. Keys are stored hashed (SHA-256 hex).
CREATE TABLE IF NOT EXISTS api_keys (
  key_hash    TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  scope       TEXT,                    -- NULL = all films; else JSON array of film ids
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  revoked_at  TEXT,
  last_used_at TEXT
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
