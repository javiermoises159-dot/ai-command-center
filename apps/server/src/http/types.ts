/**
 * A tiny framework-agnostic HTTP shape.
 *
 * Route handlers are plain functions from `HttpRequest` to `HttpResponse`, so
 * the entire API surface is unit-testable without booting a server, and Express
 * is reduced to a thin adapter in `../express-adapter.ts`. Replacing Express
 * with Fastify or Node's own http server would not touch a single handler.
 */

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export interface HttpRequest {
  method: HttpMethod;
  /** Path without query string, e.g. "/api/missions/abc". */
  path: string;
  query: Record<string, string | undefined>;
  body: unknown;
  headers: Record<string, string | undefined>;
}

export interface HttpResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export type RouteParams = Record<string, string>;
export type RouteHandler = (request: HttpRequest, params: RouteParams) => Promise<HttpResponse>;

export interface Route {
  method: HttpMethod;
  /** Pattern with `:name` segments, e.g. "/api/missions/:id". */
  pattern: string;
  handler: RouteHandler;
}

export function json(status: number, body: unknown): HttpResponse {
  return { status, body };
}

/** Match a concrete path against a `:param` pattern. Returns null on no match. */
export function matchPath(pattern: string, path: string): RouteParams | null {
  const patternParts = pattern.split('/').filter(Boolean);
  const pathParts = path.split('/').filter(Boolean);
  if (patternParts.length !== pathParts.length) return null;

  const params: RouteParams = {};
  for (let i = 0; i < patternParts.length; i += 1) {
    const expected = patternParts[i];
    const actual = pathParts[i];
    if (expected === undefined || actual === undefined) return null;

    if (expected.startsWith(':')) {
      const decoded = safeDecode(actual);
      if (decoded === null) return null;
      params[expected.slice(1)] = decoded;
      continue;
    }
    if (expected !== actual) return null;
  }
  return params;
}

function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    // A malformed %-escape must be a 404, not a 500.
    return null;
  }
}
