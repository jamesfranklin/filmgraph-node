/**
 * Issue (or revoke) an API key for a consumer.
 *
 *   npm run issue-key -- --label "Doc Society staff"                 # all films, local D1
 *   npm run issue-key -- --label "Glimmer app" --scope slug1,tmdb:2 --remote
 *   npm run issue-key -- --revoke <key> --remote
 *   npm run issue-key -- --list --remote
 *
 * The plaintext key is printed ONCE; only its SHA-256 is stored.
 */

import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";

const args: string[] = process.argv.slice(2);
const flag = (n: string): string | undefined => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const remote = args.includes("--remote");
const envName = flag("--env");
const q = (v: unknown) => `'${String(v).replace(/'/g, "''")}'`;

const run = (sql: string, json = false) => {
  const cmd = ["wrangler", "d1", "execute", "filmgraph", remote ? "--remote" : "--local", `--command=${sql}`, "-y"];
  if (envName) cmd.push("--env", envName);
  if (json) cmd.push("--json");
  return execFileSync("npx", cmd, { encoding: "utf8", stdio: json ? ["ignore", "pipe", "inherit"] : "inherit" });
};
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

if (args.includes("--list")) {
  const out = run("SELECT label, scope, created_at, revoked_at, last_used_at FROM api_keys ORDER BY created_at", true);
  console.table(JSON.parse(out)[0].results);
} else if (flag("--revoke")) {
  run(`UPDATE api_keys SET revoked_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE key_hash = ${q(sha(flag("--revoke")!))}`);
  console.log("revoked");
} else {
  const label = flag("--label");
  if (!label) {
    console.error("usage: issue-key.ts --label <consumer> [--scope ref1,ref2] [--remote] [--env name] | --revoke <key> | --list");
    process.exit(2);
  }
  const scopeRefs = flag("--scope")?.split(",").map((s: string) => s.trim()).filter(Boolean);
  let scopeSql = "NULL";
  if (scopeRefs?.length) {
    // Resolve refs to film ids now so the key stores ids, not slugs that may change.
    const where = scopeRefs
      .map((r: string) => {
        const m = /^([a-z]+):(.+)$/.exec(r);
        if (/^[0-9a-f-]{36}$/i.test(r)) return `id = ${q(r)}`;
        if (m) return `id IN (SELECT film_id FROM film_external_ids WHERE system = ${q(m[1])} AND value = ${q(m[2])})`;
        return `slug = ${q(r.toLowerCase())}`;
      })
      .join(" OR ");
    const out = run(`SELECT id FROM films WHERE ${where}`, true);
    const ids = (JSON.parse(out)[0].results as { id: string }[]).map((r) => r.id);
    if (ids.length !== scopeRefs.length) console.warn(`warning: ${scopeRefs.length} refs → ${ids.length} films`);
    scopeSql = q(JSON.stringify(ids));
  }
  const key = `fg_${randomBytes(24).toString("base64url")}`;
  run(`INSERT INTO api_keys (key_hash, label, scope) VALUES (${q(sha(key))}, ${q(label)}, ${scopeSql})`);
  console.log(`\nKey for "${label}" (shown once):\n\n  ${key}\n`);
}
