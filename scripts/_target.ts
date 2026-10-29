/** Where a script's SQL goes. Two targets, picked by environment:
 *
 *   FILMGRAPH_DB unset  → Cloudflare D1 through `wrangler d1 execute`
 *                         (--local by default, --remote / --env as flags)
 *   FILMGRAPH_DB set    → libSQL: `file:./node.db`, `libsql://…` or `http(s)://…`
 *                         (+ FILMGRAPH_DB_TOKEN), the same store the Node and
 *                         Deno entries read.
 */
import { execFileSync } from "node:child_process";

export interface Target {
  exec(sql: string): Promise<void>;
  query<T = Record<string, unknown>>(sql: string): Promise<T[]>;
  /** Release the connection so the script can exit. */
  close(): void;
  describe: string;
}

export async function target(args: string[]): Promise<Target> {
  const url = process.env.FILMGRAPH_DB;
  if (url) {
    const { createClient } = await import("@libsql/client");
    const client = createClient({ url, authToken: process.env.FILMGRAPH_DB_TOKEN });
    return {
      describe: url,
      exec: async (sql) => {
        await client.executeMultiple(sql);
      },
      query: async <T>(sql: string) => (await client.execute(sql)).rows.map((r) => ({ ...(r as unknown as T) })),
      close: () => client.close(),
    };
  }
  const remote = args.includes("--remote");
  const envName = args.includes("--env") ? args[args.indexOf("--env") + 1] : undefined;
  const base = ["wrangler", "d1", "execute", "filmgraph", remote ? "--remote" : "--local", "-y", ...(envName ? ["--env", envName] : [])];
  return {
    describe: `D1 filmgraph (${remote ? "remote" : "local"}${envName ? `, env ${envName}` : ""})`,
    exec: async (sql) => {
      // wrangler wants a file for anything beyond a one-liner.
      const { writeFileSync, mkdtempSync } = await import("node:fs");
      const { join } = await import("node:path");
      const { tmpdir } = await import("node:os");
      const file = join(mkdtempSync(join(tmpdir(), "fg-")), "stmt.sql");
      writeFileSync(file, sql);
      execFileSync("npx", [...base, `--file=${file}`], { stdio: "inherit" });
    },
    query: async <T>(sql: string) => {
      const out = execFileSync("npx", [...base, `--command=${sql}`, "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
      return JSON.parse(out)[0].results as T[];
    },
    close: () => {},
  };
}
