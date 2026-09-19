/**
 * The API router — every endpoint, with no framework dependency.
 *
 * `createRouter` returns a single `handle(request)` function. The Express
 * adapter calls it; tests call it directly.
 */

import {
  DomainError,
  parseCreateMissionInput,
  parseListMissionsQuery,
  parseRunMissionInput,
  toDomainError,
  type Logger,
} from '@acc/domain';
import type { MissionService } from '@acc/orchestrator';
import type { ProviderRegistry } from '@acc/providers';

import { json, matchPath, type HttpRequest, type HttpResponse, type Route } from './types.ts';
import {
  serializeAgentCatalog,
  serializeMissionDetail,
  serializeMissionSummary,
  serializeProviders,
  serializeRun,
  type ApiErrorDTO,
} from './serialize.ts';

export interface RouterDeps {
  missions: MissionService;
  providers: ProviderRegistry;
  logger: Logger;
  /** Reported by /api/health so a deploy can be identified. */
  version: string;
}

export interface Router {
  handle(request: HttpRequest): Promise<HttpResponse>;
  routes: readonly Route[];
}

export function createRouter(deps: RouterDeps): Router {
  const log = deps.logger.child({ component: 'router' });

  const routes: Route[] = [
    {
      method: 'GET',
      pattern: '/api/health',
      handler: async () =>
        json(200, {
          status: 'ok',
          version: deps.version,
          provider: deps.providers.defaultProviderId(),
          time: new Date().toISOString(),
        }),
    },

    {
      method: 'GET',
      pattern: '/api/agents',
      handler: async () => json(200, { items: serializeAgentCatalog() }),
    },

    {
      method: 'GET',
      pattern: '/api/providers',
      handler: async () =>
        json(200, {
          items: serializeProviders(deps.providers.describe()),
          defaultProviderId: deps.providers.defaultProviderId(),
        }),
    },

    {
      method: 'GET',
      pattern: '/api/stats',
      handler: async () => json(200, await deps.missions.stats()),
    },

    {
      method: 'POST',
      pattern: '/api/missions',
      handler: async (request) => {
        const input = parseCreateMissionInput(request.body);
        const created = await deps.missions.create(input);

        // 202 when work was queued, 201 when the mission was only created.
        // The client gets the full mission either way, so it can render the
        // pipeline immediately and start polling.
        return json(created.run === null ? 201 : 202, {
          mission: serializeMissionDetail(created.mission),
          run: created.run === null ? null : serializeRun(created.run),
        });
      },
    },

    {
      method: 'GET',
      pattern: '/api/missions',
      handler: async (request) => {
        const query = parseListMissionsQuery(request.query);
        const { items, total } = await deps.missions.list(query);
        return json(200, {
          items: items.map(serializeMissionSummary),
          total,
          limit: query.limit,
          offset: query.offset,
        });
      },
    },

    {
      method: 'GET',
      pattern: '/api/missions/:id',
      handler: async (_request, params) => {
        const detail = await deps.missions.get(requireParam(params, 'id'));
        return json(200, serializeMissionDetail(detail));
      },
    },

    {
      method: 'POST',
      pattern: '/api/missions/:id/run',
      handler: async (request, params) => {
        const input = parseRunMissionInput(request.body);
        const run = await deps.missions.run(requireParam(params, 'id'), input);
        return json(202, { run: serializeRun(run) });
      },
    },
  ];

  async function handle(request: HttpRequest): Promise<HttpResponse> {
    let pathMatched = false;

    for (const route of routes) {
      const params = matchPath(route.pattern, request.path);
      if (params === null) continue;
      pathMatched = true;
      if (route.method !== request.method) continue;

      try {
        return await route.handler(request, params);
      } catch (error) {
        return errorResponse(error, log);
      }
    }

    // A known path with the wrong verb is a 405, not a 404 — it tells a client
    // author they are close rather than sending them hunting for a typo.
    return pathMatched
      ? errorBody(405, 'method_not_allowed', `${request.method} is not allowed on ${request.path}.`)
      : errorBody(404, 'not_found', `No route matches ${request.method} ${request.path}.`);
  }

  return { handle, routes };
}

function requireParam(params: Record<string, string>, name: string): string {
  const value = params[name];
  if (value === undefined) throw new Error(`Route parameter ":${name}" was not captured.`);
  return value;
}

function errorBody(status: number, code: string, message: string, issues: ApiErrorDTO['error']['issues'] = []) {
  return json(status, { error: { code, message, issues } } satisfies ApiErrorDTO);
}

function errorResponse(error: unknown, log: Logger): HttpResponse {
  const domainError = toDomainError(error);

  // 5xx is our fault and gets logged with the internal message; 4xx is the
  // caller's and stays quiet so a bad client cannot flood the logs.
  if (domainError.status >= 500) {
    log.error('request failed', { code: domainError.code, message: domainError.message });
  } else {
    log.debug('request rejected', { code: domainError.code, message: domainError.message });
  }

  return errorBody(
    domainError.status,
    domainError.code,
    domainError.publicMessage,
    domainError.issues,
  );
}

export function isDomainError(error: unknown): error is DomainError {
  return error instanceof DomainError;
}
