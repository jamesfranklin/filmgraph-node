/** Minimal stateless MCP server over Streamable HTTP (JSON responses only, no
 *  SSE, no sessions). Six tools, fixed by docs/node-contract.md#mcp. Each tool
 *  is a thin alias over the same Repo methods the REST routes use, so the two
 *  surfaces return identical JSON. */

import type { Env } from "./env";
import { ApiError } from "./envelope";
import type { Repo } from "./repo";
import { manifestData } from "./manifest";

/** Newest revision spoken; `server/discover` leads with it. 2026-07-28
 *  dropped the initialize handshake for per-request `_meta`; the two older
 *  revisions keep `initialize`. Both doors stay open. */
export const MCP_PROTOCOL_VERSION = "2026-07-28";
const SUPPORTED_PROTOCOL_VERSIONS = [MCP_PROTOCOL_VERSION, "2025-11-25", "2025-06-18"] as const;
const UNSUPPORTED_PROTOCOL_VERSION = -32022;
const META_PROTOCOL_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_SERVER_INFO = "io.modelcontextprotocol/serverInfo";
const LIST_TTL_MS = 3_600_000;

function negotiatedVersion(params: Record<string, unknown> | undefined): string {
  const asked = typeof params?.protocolVersion === "string" ? params.protocolVersion : "";
  return (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(asked) ? asked : "2025-06-18";
}

type JsonRpcId = string | number | null;
interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown> & { _meta?: Record<string, unknown> };
}

const ok = (id: JsonRpcId, result: unknown) => ({ jsonrpc: "2.0", id, result });
const err = (id: JsonRpcId, code: number, message: string, data?: unknown) => ({
  jsonrpc: "2.0",
  id,
  error: { code, message, ...(data === undefined ? {} : { data }) },
});

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export function toolDefinitions(env: Env, hasVenues: boolean): ToolDef[] {
  const where = `on the ${env.NODE_NAME} (FilmGraph node "${env.NODE_ID}", layer ${env.NODE_LAYER})`;
  const tools: ToolDef[] = [
    {
      name: "node_info",
      description: `Describe this FilmGraph node: operator, layer, which node and edge types it serves, capabilities. Call first when holding several nodes. Node: ${env.NODE_ID}.`,
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "search_films",
      description: `Search films by title ${where}. Returns Film nodes (id, slug, title, year, external_ids, …). Use get_film with the slug or id for everything the node knows about one film.`,
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Title substring, case-insensitive" },
          limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
    {
      name: "resolve_film",
      description: `Find the film ${where} matching a title+year or known external ids (tmdb, imdb, mx, …). Returns candidates best-first with confidence (1.0 external id, 0.8 exact slug, 0.6 slug with year ±1). Use this to map a film you know from elsewhere onto this node.`,
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string" },
          year: { type: "integer" },
          tmdb: { type: ["integer", "string"] },
          imdb: { type: "string" },
          external_ids: { type: "object", additionalProperties: { type: ["string", "integer"] } },
        },
        additionalProperties: false,
      },
    },
    {
      name: "get_film",
      description: `Everything this node knows about one film ${where}: the Film node plus every edge grouped by type (SCREENED_AT, FUNDED, DISTRIBUTED_BY, …) with the far node inlined. ref is a UUID, a slug like "parasite-2019", or a prefixed external id like "tmdb:496243".`,
      inputSchema: {
        type: "object",
        properties: { ref: { type: "string", description: "UUID | slug | system:id" } },
        required: ["ref"],
        additionalProperties: false,
      },
    },
  ];
  if (hasVenues) {
    tools.push(
      {
        name: "search_venues",
        description: `Search cinema venues ${where} by name, optionally filtered by ISO country code.`,
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            country: { type: "string", description: "ISO 3166-1 alpha-2, e.g. GB" },
            limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
          },
          required: ["query"],
          additionalProperties: false,
        },
      },
      {
        name: "get_venue",
        description: `One venue ${where} plus the films this node links to it.`,
        inputSchema: {
          type: "object",
          properties: { ref: { type: "string", description: "Venue id" } },
          required: ["ref"],
          additionalProperties: false,
        },
      },
    );
  }
  return tools;
}

export async function callTool(env: Env, repo: Repo, name: string, args: Record<string, unknown>, origin: string) {
  const str = (k: string) => (typeof args[k] === "string" ? (args[k] as string) : undefined);
  const int = (k: string) => (typeof args[k] === "number" ? Math.trunc(args[k] as number) : args[k] ? Number(args[k]) : undefined);

  switch (name) {
    case "node_info":
      return manifestData(env, repo, origin);
    case "search_films": {
      const q = str("query");
      if (!q) throw new ApiError("bad_request", "query is required");
      return { items: await repo.searchFilms(q, int("limit") ?? 20) };
    }
    case "resolve_film": {
      const ext: Record<string, string> = {};
      for (const k of ["tmdb", "imdb", "letterboxd", "wikidata", "eidr", "mx"]) {
        if (args[k] !== undefined && args[k] !== null && args[k] !== "") ext[k] = String(args[k]);
      }
      if (args.external_ids && typeof args.external_ids === "object") {
        for (const [k, v] of Object.entries(args.external_ids as Record<string, unknown>)) ext[k] = String(v);
      }
      const title = str("title");
      const year = int("year");
      if (!Object.keys(ext).length && !(title && year)) {
        throw new ApiError("bad_request", "Supply title and year, or at least one external id");
      }
      return { items: await repo.resolveFilm(title, year, ext) };
    }
    case "get_film": {
      const ref = str("ref");
      if (!ref) throw new ApiError("bad_request", "ref is required");
      const film = await repo.resolveRef(ref);
      if (!film) throw new ApiError("not_found", `Film ${ref} not found`);
      const body = await repo.filmGraph(film);
      return { node: env.NODE_ID, ...body, generated_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z") };
    }
    case "search_venues": {
      const q = str("query");
      if (!q) throw new ApiError("bad_request", "query is required");
      return { items: await repo.searchNodes("Venue", q, str("country"), int("limit") ?? 20) };
    }
    case "get_venue": {
      const ref = str("ref");
      if (!ref) throw new ApiError("bad_request", "ref is required");
      const venue = await repo.getNode("Venue", ref);
      if (!venue) throw new ApiError("not_found", `Venue ${ref} not found`);
      return { ...venue, films: await repo.filmsForNode(venue.id) };
    }
    default:
      throw new ApiError("not_found", `Unknown tool ${name}`);
  }
}

export async function handleMcp(env: Env, repo: Repo, req: Request): Promise<Response> {
  const origin = env.PUBLIC_URL || new URL(req.url).origin;
  if (req.method !== "POST") {
    return new Response(JSON.stringify(err(null, -32000, "This server is stateless: POST JSON-RPC to this URL")), {
      status: 405,
      headers: { "content-type": "application/json", allow: "POST" },
    });
  }
  let payload: JsonRpcRequest | JsonRpcRequest[];
  try {
    payload = (await req.json()) as JsonRpcRequest | JsonRpcRequest[];
  } catch {
    return Response.json(err(null, -32700, "Parse error"), { status: 400 });
  }
  const batch = Array.isArray(payload);
  const requests: JsonRpcRequest[] = batch ? (payload as JsonRpcRequest[]) : [payload as JsonRpcRequest];
  const responses: unknown[] = [];

  for (const r of requests) {
    if (!r || r.jsonrpc !== "2.0" || typeof r.method !== "string") {
      responses.push(err((r as JsonRpcRequest)?.id ?? null, -32600, "Invalid Request"));
      continue;
    }
    const id = r.id ?? null;
    const isNotification = r.id === undefined;
    const serverInfo = { name: `filmgraph-node:${env.NODE_ID}`, version: "0.1.0" };
    const instructions = `FilmGraph node "${env.NODE_ID}" (${env.NODE_NAME}), layer ${env.NODE_LAYER}. Films are addressed by UUID, slug (title-year) or prefixed external id (tmdb:123). Call node_info to see which node and edge types this node serves; absent types are not served, not empty.`;
    const metaVersion = r.params?._meta?.[META_PROTOCOL_VERSION];
    if (typeof metaVersion === "string" && !(SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(metaVersion)) {
      if (!isNotification) responses.push(err(id, UNSUPPORTED_PROTOCOL_VERSION, `Unsupported protocol version ${metaVersion}`, { supportedVersions: SUPPORTED_PROTOCOL_VERSIONS }));
      continue;
    }
    try {
      switch (r.method) {
        case "server/discover":
          responses.push(
            ok(id, {
              supportedVersions: SUPPORTED_PROTOCOL_VERSIONS,
              capabilities: { tools: { listChanged: false } },
              instructions,
              ttlMs: LIST_TTL_MS,
              cacheScope: "private",
              _meta: { [META_SERVER_INFO]: serverInfo },
            }),
          );
          break;
        case "initialize":
          responses.push(
            ok(id, {
              protocolVersion: negotiatedVersion(r.params),
              capabilities: { tools: { listChanged: false } },
              serverInfo,
              instructions,
            }),
          );
          break;
        case "ping":
          responses.push(ok(id, {}));
          break;
        case "tools/list": {
          const { node_types } = await repo.servedTypes();
          responses.push(ok(id, { tools: toolDefinitions(env, node_types.includes("Venue")), ttlMs: LIST_TTL_MS, cacheScope: "private" }));
          break;
        }
        case "tools/call": {
          const p = (r.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
          if (!p.name) {
            responses.push(err(id, -32602, "params.name is required"));
            break;
          }
          try {
            const result = await callTool(env, repo, p.name, p.arguments ?? {}, origin);
            responses.push(
              ok(id, { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result, isError: false }),
            );
          } catch (e) {
            if (e instanceof ApiError) {
              // Tool-level error: the model should see it and recover.
              const body = { error: e.code, detail: e.detail };
              responses.push(ok(id, { content: [{ type: "text", text: JSON.stringify(body) }], structuredContent: body, isError: true }));
            } else throw e;
          }
          break;
        }
        default:
          if (r.method.startsWith("notifications/")) break; // accepted, no response
          responses.push(err(id, -32601, `Method not found: ${r.method}`));
      }
    } catch (e) {
      responses.push(err(id, -32603, "Internal error", String((e as Error)?.message ?? e)));
    }
    if (isNotification && responses.length && (responses[responses.length - 1] as { id: JsonRpcId }).id === null) {
      responses.pop();
    }
  }

  if (!responses.length) return new Response(null, { status: 202 });
  return Response.json(batch ? responses : responses[0]);
}
