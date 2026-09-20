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
import {
  cancelMissionResponseSchema,
  madreActivityResponseSchema,
  madreAgentsResponseSchema,
  madreApprovalsResponseSchema,
  madreBudgetResponseSchema,
  madreCompileResponseSchema,
  madreDecisionResponseSchema,
  madreForgetResponseSchema,
  madreMemoryResponseSchema,
  madreOverviewSchema,
  madrePermissionsResponseSchema,
  madreProvidersResponseSchema,
  madreRememberResponseSchema,
  madreSnapshotSchema,
  madreTraceResponseSchema,
  madreToolsResponseSchema,
  type MadreBudgetRequest,
  type MadreRememberRequest,
} from './madre.ts';
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
      throw new ApiClientError(0, 'network_error', 'No se pudo conectar con el servidor. ¿Está en marcha?');
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
      throw new ApiClientError(response.status, 'unknown_error', `La solicitud falló con el estado ${response.status}.`);
    }

    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      throw new ApiClientError(
        response.status,
        'contract_mismatch',
        `El servidor devolvió una respuesta que esta aplicación no entiende (${method} ${path}).`,
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

    // -- MADRE ---------------------------------------------------------------

    madreOverview: (signal?: AbortSignal) => request('GET', '/api/madre/overview', madreOverviewSchema, signal ? { signal } : {}),
    madreAgents: (signal?: AbortSignal) => request('GET', '/api/madre/agents', madreAgentsResponseSchema, signal ? { signal } : {}),
    madreProviders: (signal?: AbortSignal) => request('GET', '/api/madre/providers', madreProvidersResponseSchema, signal ? { signal } : {}),
    madreTools: (signal?: AbortSignal) => request('GET', '/api/madre/tools', madreToolsResponseSchema, signal ? { signal } : {}),
    madrePermissions: (signal?: AbortSignal) => request('GET', '/api/madre/permissions', madrePermissionsResponseSchema, signal ? { signal } : {}),
    madreActivity: (limit = 60, signal?: AbortSignal) => request('GET', '/api/madre/activity', madreActivityResponseSchema, { query: { limit }, ...(signal ? { signal } : {}) }),
    madreCompile: (prompt: string, signal?: AbortSignal) => request('POST', '/api/madre/compile', madreCompileResponseSchema, { body: { prompt }, ...(signal ? { signal } : {}) }),
    madreMemory: (query: { q?: string; type?: string; limit?: number } = {}, signal?: AbortSignal) => request('GET', '/api/madre/memory', madreMemoryResponseSchema, { query, ...(signal ? { signal } : {}) }),
    madreRemember: (body: MadreRememberRequest, signal?: AbortSignal) => request('POST', '/api/madre/memory', madreRememberResponseSchema, { body, ...(signal ? { signal } : {}) }),
    madreForget: (id: string, signal?: AbortSignal) => request('DELETE', `/api/madre/memory/${encodeURIComponent(id)}`, madreForgetResponseSchema, signal ? { signal } : {}),
    madreBudget: (signal?: AbortSignal) => request('GET', '/api/madre/budget', madreBudgetResponseSchema, signal ? { signal } : {}),
    madreSetBudget: (body: MadreBudgetRequest, signal?: AbortSignal) => request('PATCH', '/api/madre/budget', madreBudgetResponseSchema, { body, ...(signal ? { signal } : {}) }),
    madreApprovals: (signal?: AbortSignal) => request('GET', '/api/madre/approvals', madreApprovalsResponseSchema, signal ? { signal } : {}),
    decideApproval: (id: string, decision: 'approve' | 'deny', note?: string, signal?: AbortSignal) =>
      request('POST', `/api/madre/approvals/${encodeURIComponent(id)}/${decision}`, madreDecisionResponseSchema, { body: note === undefined ? {} : { note }, ...(signal ? { signal } : {}) }),
    missionMadre: (id: string, signal?: AbortSignal) => request('GET', `/api/missions/${encodeURIComponent(id)}/madre`, madreSnapshotSchema, signal ? { signal } : {}),
    missionTrace: (id: string, signal?: AbortSignal) =>
      request('GET', `/api/missions/${encodeURIComponent(id)}/trace`, madreTraceResponseSchema, signal ? { signal } : {}),
    /** Probes every provider. Slower than the rest: it goes out to the network. */
    madreProviderHealth: (signal?: AbortSignal) =>
      request('POST', '/api/madre/providers/health', madreProvidersResponseSchema, signal ? { signal } : {}),
    cancelMission: (id: string, signal?: AbortSignal) => request('POST', `/api/missions/${encodeURIComponent(id)}/cancel`, cancelMissionResponseSchema, signal ? { signal } : {}),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
