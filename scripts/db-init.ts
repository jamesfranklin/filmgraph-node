/** Create the node's tables (schema.sql) in whichever database the scripts
 *  target — D1 via wrangler, or FILMGRAPH_DB for libSQL / a SQLite file. */
import { readFileSync } from "node:fs";
import { target } from "./_target";

const t = await target(process.argv.slice(2));
await t.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
console.log(`schema applied to ${t.describe}`);
t.close();
