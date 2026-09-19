/**
 * Typed API client.
 *
 * Responses are parsed with the Zod schemas, so a server/client mismatch
 * surfaces as a clear error at the boundary instead of an `undefined` deep
 * inside a component. Used by the web app; it holds no API keys and talks only
 * to our own server.
 */

import {
  apiErrorSchema,
  createMissionResponseSchema,
  healthResponseSchema,
  listAgentsResponseSchema,
  listMissionsResponseSchema,
  listProvidersResponseSchema,
  missionDetailSchema,
  runMissionResponseSchema,
  statsResponseSchema,
  type CreateMissionRequest,
  type CreateMissionResponse,
  type HealthResponse,
  type ListAgentsResponse,
  type ListMissionsResponse,
  type ListProvidersResponse,
  type MissionDetail,
  type MissionStatus,
  type RunMissionRequest,
  type RunMissionResponse,
  type StatsResponse,
} from './schemas.ts';
import type { ZodType } from 'zod';

/** Error carrying the server's own code and field issues. */
export class ApiClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly issues: { path: string; message: string }[] = [],
  ) {
    super(message);
    this.name = 'ApiClientError';
  }

  /** The message for a specific field, when the server reported one. */
  issueFor(path: string): string | undefined {
    return this.issues.find((i) => i.path === path)?.message;
  }
}

export interface ApiClientOptions {
  /** Absolute (`https://api.example.com`) or relative (`''` for same-origin). */
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
}

/** Never contacted: only used so `new URL()` can parse a relative path. */
const PLACEHOLDER_ORIGIN = 'http://request.local';

export function createApiClient(options: ApiClientOptions) {
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const baseUrl = options.baseUrl.replace(/\/$/, '');

  async function request<T>(
    method: string,
    path: string,
    schema: ZodType<T>,
    init: { body?: unknown; query?: Record<string, string | number | undefined>; signal?: AbortSignal } = {},
  ): Promise<T> {
    // This package is isomorphic: it is typechecked with Node types on the
    // server and runs in the browser. `globalThis.location` exists in neither
    // type world reliably, so the URL is built against a placeholder origin and
    // reduced back to a relative path when the caller gave a relative baseUrl.
    const absolute = /^https?:\/\//i.test(baseUrl);
    const url = new URL(`${baseUrl}${path}`, absolute ? undefined : PLACEHOLDER_ORIGIN);
    for (const [key, value] of Object.entries(init.query ?? {})) {
      if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
    }
    const target = absolute ? url.toString() : `${url.pathname}${url.search}`;

    let response: Response;
    try {
      response = await doFetch(target, {
        method,
        headers: init.body === undefined ? {} : { 'content-type': 'application/json' },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        ...(init.signal ? { signal: init.signal } : {}),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      throw new ApiClientError(0, 'network_error', 'Could not reach the server. Is it running?');
    }

    const payload: unknown = await response.json().catch(() => null);

    if (!response.ok) {
      const parsed = apiErrorSchema.safeParse(payload);
      if (parsed.success) {
        throw new ApiClientError(
          response.status,
          parsed.data.error.code,
          parsed.data.error.message,
          parsed.data.error.issues,
        );
      }
      throw new ApiClientError(response.status, 'unknown_error', `Request failed with status ${response.status}.`);
    }

    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      throw new ApiClientError(
        response.status,
        'contract_mismatch',
        `The server returned a shape this client does not understand (${method} ${path}).`,
      );
    }
    return parsed.data;
  }

  return {
    health: (signal?: AbortSignal): Promise<HealthResponse> =>
      request('GET', '/api/health', healthResponseSchema, signal ? { signal } : {}),

    listAgents: (signal?: AbortSignal): Promise<ListAgentsResponse> =>
      request('GET', '/api/agents', listAgentsResponseSchema, signal ? { signal } : {}),

    listProviders: (signal?: AbortSignal): Promise<ListProvidersResponse> =>
      request('GET', '/api/providers', listProvidersResponseSchema, signal ? { signal } : {}),

    stats: (signal?: AbortSignal): Promise<StatsResponse> =>
      request('GET', '/api/stats', statsResponseSchema, signal ? { signal } : {}),

    createMission: (body: CreateMissionRequest, signal?: AbortSignal): Promise<CreateMissionResponse> =>
      request('POST', '/api/missions', createMissionResponseSchema, { body, ...(signal ? { signal } : {}) }),

    listMissions: (
      query: { limit?: number; offset?: number; status?: MissionStatus } = {},
      signal?: AbortSignal,
    ): Promise<ListMissionsResponse> =>
      request('GET', '/api/missions', listMissionsResponseSchema, { query, ...(signal ? { signal } : {}) }),

    getMission: (id: string, signal?: AbortSignal): Promise<MissionDetail> =>
      request('GET', `/api/missions/${encodeURIComponent(id)}`, missionDetailSchema, signal ? { signal } : {}),

    runMission: (id: string, body: RunMissionRequest = {}, signal?: AbortSignal): Promise<RunMissionResponse> =>
      request('POST', `/api/missions/${encodeURIComponent(id)}/run`, runMissionResponseSchema, {
        body,
        ...(signal ? { signal } : {}),
      }),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
