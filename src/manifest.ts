import { BASE_CAPABILITIES, type Env } from "./env";
import type { Repo } from "./repo";

/** docs/node-contract.md#node-manifest */
export async function manifestData(env: Env, repo: Repo, origin: string) {
  const [{ node_types, edge_types }, film_count, updated] = await Promise.all([
    repo.servedTypes(),
    repo.filmCount(),
    env.db.first<{ value: string }>("SELECT value FROM meta WHERE key = 'updated_at'"),
  ]);
  const capabilities: string[] = [...BASE_CAPABILITIES];
  if (node_types.includes("Venue")) capabilities.push("venues");
  if (node_types.includes("Festival")) capabilities.push("festivals");
  if (node_types.includes("Distributor")) capabilities.push("distributors");
  return {
    node_id: env.NODE_ID,
    name: env.NODE_NAME,
    operator: { name: env.OPERATOR_NAME, url: env.OPERATOR_URL },
    layer: Number(env.NODE_LAYER) === 2 ? 2 : 1,
    auth: env.NODE_AUTH,
    node_types,
    edge_types,
    capabilities,
    mcp: { url: `${(env.PUBLIC_URL || origin).replace(/\/$/, "")}/mcp` },
    film_count,
    ...(updated ? { updated_at: updated.value } : {}),
  };
}
