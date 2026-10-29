import { SCHEMA_VERSION } from "./env";

export type ErrorCode =
  | "bad_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "rate_limit_exceeded"
  | "unsupported";

const STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  rate_limit_exceeded: 429,
  unsupported: 501,
};

export const envelope = (data: unknown) => ({ schema_version: SCHEMA_VERSION, data });

export const paginate = <T>(items: T[], page: number, limit: number) => {
  limit = Math.max(1, Math.min(limit, 100));
  page = Math.max(1, page);
  const start = (page - 1) * limit;
  return envelope({ page, limit, count: items.length, items: items.slice(start, start + limit) });
};

export class ApiError extends Error {
  constructor(public code: ErrorCode, public detail: string) {
    super(detail);
  }
  get status() {
    return STATUS[this.code];
  }
  body() {
    return { schema_version: SCHEMA_VERSION, error: this.code, detail: this.detail };
  }
}
