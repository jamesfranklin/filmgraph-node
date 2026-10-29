import type { Env } from "./env";
import { ApiError } from "./envelope";

export interface Principal {
  label: string;
  /** null = every film on the node. */
  scope: Set<string> | null;
}

export async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function extractKey(req: Request): string | null {
  const h = req.headers.get("x-api-key");
  if (h) return h.trim();
  const auth = req.headers.get("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return new URL(req.url).searchParams.get("api_key");
}

/** Resolve the request's key to a principal. Returns null when no key was sent. */
export async function authenticate(env: Env, req: Request): Promise<Principal | null> {
  const key = extractKey(req);
  if (!key) return null;
  const hash = await sha256Hex(key);
  const row = await env.db.first<{ label: string; scope: string | null }>(
    "SELECT label, scope FROM api_keys WHERE key_hash = ?1 AND revoked_at IS NULL",
    hash,
  );
  if (!row) throw new ApiError("unauthorized", "Valid API key required");
  // Fire-and-forget usage stamp; failures are irrelevant to the request.
  env.db.run("UPDATE api_keys SET last_used_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE key_hash = ?1", hash).catch(() => {});
  return { label: row.label, scope: row.scope ? new Set(JSON.parse(row.scope) as string[]) : null };
}

export function requireAuth(env: Env, principal: Principal | null): void {
  if (env.NODE_AUTH === "required" && !principal) {
    throw new ApiError("unauthorized", "Valid API key required");
  }
}

export const inScope = (p: Principal | null, filmId: string) => !p?.scope || p.scope.has(filmId);
