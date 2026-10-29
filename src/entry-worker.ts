/** Cloudflare Workers entry: node config from vars, storage from the D1 binding. */
import { createApp } from "./app";
import { d1Db, type D1Like } from "./db";
import { configFrom, type NodeConfig } from "./env";

type Bindings = Partial<Record<keyof NodeConfig, string>> & { DB: D1Like };

export default createApp((raw) => {
  const { DB, ...vars } = raw as Bindings;
  return { ...configFrom(vars), db: d1Db(DB) };
});
