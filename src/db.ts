/** The one storage interface the node needs — four calls over a SQLite-shaped
 *  database. Everything above this file is host-neutral; everything the host
 *  provides (Cloudflare D1, libSQL/Turso, a local SQLite file, Bunny's edge
 *  database) plugs in through one of the adapters below.
 *
 *  SQL is written once, for SQLite, with `?1 ?2` positional parameters. */

export interface Db {
  first<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T | null>;
  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]>;
  run(sql: string, ...params: unknown[]): Promise<void>;
  /** Several statements in one string (schema, loads). */
  exec(sql: string): Promise<void>;
}

// --- Cloudflare D1 -------------------------------------------------------------

/** Structural view of D1Database — enough to adapt it without importing the
 *  Workers types into host-neutral code. */
export interface D1Like {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      first<T>(): Promise<T | null>;
      all<T>(): Promise<{ results: T[] }>;
      run(): Promise<unknown>;
    };
  };
  exec(sql: string): Promise<unknown>;
}

export function d1Db(d1: D1Like): Db {
  return {
    first: <T>(sql: string, ...p: unknown[]) => d1.prepare(sql).bind(...p).first<T>(),
    all: async <T>(sql: string, ...p: unknown[]) => (await d1.prepare(sql).bind(...p).all<T>()).results,
    run: async (sql, ...p) => {
      await d1.prepare(sql).bind(...p).run();
    },
    // D1's exec() takes one statement per line.
    exec: async (sql) => {
      await d1.exec(sql.replace(/\n\s*\n/g, "\n"));
    },
  };
}

// --- libSQL (Turso, Bunny Database, a local file, in-memory) ---------------------

/** Structural view of `@libsql/client`'s Client — the same four calls work on
 *  Node, Deno and Bun, so `createClient({ url: "file:node.db" })`,
 *  `libsql://…` and `http(s)://…` all fit here. */
export type SqlValue = string | number | bigint | boolean | null | Uint8Array;
export interface LibsqlLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the client's own arg type is narrower than unknown
  execute(stmt: { sql: string; args: any[] }): Promise<{ rows: unknown[] }>;
  executeMultiple(sql: string): Promise<unknown>;
}

export function libsqlDb(client: LibsqlLike): Db {
  // libSQL rows are array-like with named properties; copy to plain objects so
  // callers see the same shape D1 returns.
  const plain = <T>(row: unknown): T => {
    const r = row as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(r)) if (!/^\d+$/.test(k)) out[k] = r[k];
    return out as T;
  };
  return {
    first: async <T>(sql: string, ...args: unknown[]) => {
      const { rows } = await client.execute({ sql, args: args as SqlValue[] });
      return rows.length ? plain<T>(rows[0]) : null;
    },
    all: async <T>(sql: string, ...args: unknown[]) => (await client.execute({ sql, args: args as SqlValue[] })).rows.map((r) => plain<T>(r)),
    run: async (sql, ...args) => {
      await client.execute({ sql, args: args as SqlValue[] });
    },
    exec: async (sql) => {
      await client.executeMultiple(sql);
    },
  };
}
