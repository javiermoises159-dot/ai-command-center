/**
 * OpenAPI 3.1 document, generated from the Zod schemas.
 *
 * Zod 4 emits JSON Schema 2020-12 natively, which OpenAPI 3.1 accepts as-is —
 * no conversion library needed. Served at GET /api/openapi.json and written to
 * disk by `pnpm --filter @acc/contracts openapi`.
 */

import { z } from 'zod';

import {
  apiErrorSchema,
  createMissionRequestSchema,
  createMissionResponseSchema,
  healthResponseSchema,
  listAgentsResponseSchema,
  listMissionsResponseSchema,
  listProvidersResponseSchema,
  missionDetailSchema,
  runMissionRequestSchema,
  runMissionResponseSchema,
  statsResponseSchema,
} from './schemas.ts';
import {
  cancelMissionResponseSchema,
  madreActivityResponseSchema,
  madreAgentsResponseSchema,
  madreApprovalsResponseSchema,
  madreBudgetRequestSchema,
  madreBudgetResponseSchema,
  madreCompileRequestSchema,
  madreCompileResponseSchema,
  madreDecisionRequestSchema,
  madreDecisionResponseSchema,
  madreForgetResponseSchema,
  madreMemoryResponseSchema,
  madreOverviewSchema,
  madrePermissionsResponseSchema,
  madreProvidersResponseSchema,
  madreRememberRequestSchema,
  madreRememberResponseSchema,
  madreSnapshotSchema,
  madreTraceResponseSchema,
  madreToolsResponseSchema,
} from './madre.ts';

const SCHEMAS = {
  CreateMissionRequest: createMissionRequestSchema,
  CreateMissionResponse: createMissionResponseSchema,
  RunMissionRequest: runMissionRequestSchema,
  RunMissionResponse: runMissionResponseSchema,
  ListMissionsResponse: listMissionsResponseSchema,
  MissionDetail: missionDetailSchema,
  ListAgentsResponse: listAgentsResponseSchema,
  ListProvidersResponse: listProvidersResponseSchema,
  StatsResponse: statsResponseSchema,
  HealthResponse: healthResponseSchema,
  ApiError: apiErrorSchema,
  MadreOverview: madreOverviewSchema,
  MadreAgents: madreAgentsResponseSchema,
  MadreProviders: madreProvidersResponseSchema,
  MadreTools: madreToolsResponseSchema,
  MadrePermissions: madrePermissionsResponseSchema,
  MadreActivity: madreActivityResponseSchema,
  MadreCompileRequest: madreCompileRequestSchema,
  MadreCompileResponse: madreCompileResponseSchema,
  MadreMemory: madreMemoryResponseSchema,
  MadreRememberRequest: madreRememberRequestSchema,
  MadreRememberResponse: madreRememberResponseSchema,
  MadreForget: madreForgetResponseSchema,
  MadreBudgetRequest: madreBudgetRequestSchema,
  MadreBudget: madreBudgetResponseSchema,
  MadreApprovals: madreApprovalsResponseSchema,
  MadreDecisionRequest: madreDecisionRequestSchema,
  MadreDecision: madreDecisionResponseSchema,
  MadreSnapshot: madreSnapshotSchema,
  MadreTrace: madreTraceResponseSchema,
  CancelMissionResponse: cancelMissionResponseSchema,
} as const;

function ref(name: keyof typeof SCHEMAS) {
  return { $ref: `#/components/schemas/${name}` };
}

function jsonBody(name: keyof typeof SCHEMAS) {
  return { content: { 'application/json': { schema: ref(name) } } };
}

function errorResponse(description: string) {
  return { description, ...jsonBody('ApiError') };
}

export function buildOpenApiDocument(version = '0.1.0'): Record<string, unknown> {
  const schemas: Record<string, unknown> = {};
  for (const [name, schema] of Object.entries(SCHEMAS)) {
    schemas[name] = z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'output', unrepresentable: 'any' });
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'AI Command Center API',
      version,
      description:
        'Multi-agent mission orchestration. Mission creation and run start are asynchronous: ' +
        'both return 202 immediately and the agents execute in the background. Poll GET /api/missions/{id} for progress.',
    },
    servers: [{ url: 'http://localhost:3001', description: 'Local development' }],
    tags: [
      { name: 'missions', description: 'Create, list, inspect and re-run missions' },
      { name: 'system', description: 'Health, agent catalog, providers and stats' },
      { name: 'madre', description: 'MADRE: compile, route, approvals, memory, budget and the live registries. Documents are typed in @acc/madre.' },
    ],
    paths: {
      '/api/health': {
        get: {
          tags: ['system'],
          summary: 'Liveness probe',
          operationId: 'health',
          responses: { '200': { description: 'Server is up', ...jsonBody('HealthResponse') } },
        },
      },
      '/api/agents': {
        get: {
          tags: ['system'],
          summary: 'The agent catalog, in pipeline order',
          operationId: 'listAgents',
          responses: { '200': { description: 'Agent definitions', ...jsonBody('ListAgentsResponse') } },
        },
      },
      '/api/providers': {
        get: {
          tags: ['system'],
          summary: 'Registered AI providers and their availability',
          operationId: 'listProviders',
          responses: { '200': { description: 'Providers', ...jsonBody('ListProvidersResponse') } },
        },
      },
      '/api/stats': {
        get: {
          tags: ['system'],
          summary: 'Mission counts by status',
          operationId: 'stats',
          responses: { '200': { description: 'Counts', ...jsonBody('StatsResponse') } },
        },
      },
      '/api/missions': {
        post: {
          tags: ['missions'],
          summary: 'Create a mission and (by default) queue its first run',
          description:
            'Returns as soon as the mission, its run and its eight agent rows are persisted. ' +
            'The agents execute in the background; poll GET /api/missions/{id} to follow them.',
          operationId: 'createMission',
          requestBody: { required: true, ...jsonBody('CreateMissionRequest') },
          responses: {
            '201': { description: 'Created without starting (autoStart=false)', ...jsonBody('CreateMissionResponse') },
            '202': { description: 'Created and queued', ...jsonBody('CreateMissionResponse') },
            '400': errorResponse('Invalid payload or unknown provider'),
            '503': errorResponse('The requested provider is declared but not implemented'),
          },
        },
        get: {
          tags: ['missions'],
          summary: 'List missions, newest first',
          operationId: 'listMissions',
          parameters: [
            { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
            { name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0, default: 0 } },
            {
              name: 'status',
              in: 'query',
              schema: { type: 'string', enum: ['pending', 'running', 'completed', 'failed'] },
            },
          ],
          responses: {
            '200': { description: 'A page of missions', ...jsonBody('ListMissionsResponse') },
            '400': errorResponse('Invalid query parameters'),
          },
        },
      },
      '/api/missions/{id}': {
        get: {
          tags: ['missions'],
          summary: 'A mission with every run and agent execution',
          operationId: 'getMission',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '200': { description: 'The mission', ...jsonBody('MissionDetail') },
            '404': errorResponse('No such mission'),
          },
        },
      },
      '/api/missions/{id}/run': {
        post: {
          tags: ['missions'],
          summary: 'Queue another run of an existing mission',
          operationId: 'runMission',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: { required: false, ...jsonBody('RunMissionRequest') },
          responses: {
            '202': { description: 'Run queued', ...jsonBody('RunMissionResponse') },
            '404': errorResponse('No such mission'),
            '409': errorResponse('A run is already in flight for this mission'),
            '503': errorResponse('The requested provider is declared but not implemented'),
          },
        },
      },

      '/api/missions/{id}/trace': {
        get: {
          tags: ['madre'],
          summary: 'The full chain behind a mission: step, agent, model, tools, cost, QA and approvals',
          description:
            'Assembled from records that already exist, so it cannot drift from what happened. `trace` is null when the mission has no run yet.',
          operationId: 'getMissionTrace',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'The trace, or null', ...jsonBody('MadreTrace') }, '404': errorResponse('No such mission') },
        },
      },
      '/api/missions/{id}/madre': {
        get: {
          tags: ['madre'],
          summary: "The MADRE view of a mission: plan, step states, QA rounds, approvals and audit trail",
          operationId: 'getMissionMadre',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: '`runId` is null when the mission never ran in MADRE mode', ...jsonBody('MadreSnapshot') }, '404': errorResponse('No such mission') },
        },
      },
      '/api/missions/{id}/cancel': {
        post: {
          tags: ['madre'],
          summary: "Cancel the mission's active MADRE run",
          operationId: 'cancelMission',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: '`cancelled` is false when there was nothing to cancel', ...jsonBody('CancelMissionResponse') }, '404': errorResponse('No such mission') },
        },
      },
      '/api/madre/overview': { get: { tags: ['madre'], summary: 'World model, pending approvals, recent activity and pipeline readiness', operationId: 'madreOverview', responses: { '200': { description: 'Overview', ...jsonBody('MadreOverview') } } } },
      '/api/madre/agents': { get: { tags: ['madre'], summary: 'The agent registry, including planned agents', operationId: 'madreAgents', responses: { '200': { description: 'Agents', ...jsonBody('MadreAgents') } } } },
      '/api/madre/providers': { get: { tags: ['madre'], summary: 'Provider profiles with status CONNECTED, NOT_CONNECTED, MOCK, LOCAL or ERROR', operationId: 'madreProviders', responses: { '200': { description: 'Providers', ...jsonBody('MadreProviders') } } } },
      '/api/madre/providers/health': {
        post: {
          tags: ['madre'],
          summary: 'Probe every provider and record whether it is reachable right now',
          description:
            'A real network probe, which is why it is a POST. A provider with nothing configured reports `not_connected` without a request being made; nothing is ever reported healthy because its configuration looks complete.',
          operationId: 'madreProviderHealth',
          responses: { '200': { description: 'Profiles with refreshed health', ...jsonBody('MadreProviders') } },
        },
      },
      '/api/madre/tools': { get: { tags: ['madre'], summary: 'The tool registry with honest statuses', operationId: 'madreTools', responses: { '200': { description: 'Tools', ...jsonBody('MadreTools') } } } },
      '/api/madre/permissions': { get: { tags: ['madre'], summary: 'Permission mode per level', operationId: 'madrePermissions', responses: { '200': { description: 'Modes', ...jsonBody('MadrePermissions') } } } },
      '/api/madre/activity': {
        get: {
          tags: ['madre'], summary: 'Recent audit events', operationId: 'madreActivity',
          parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 300, default: 60 } }],
          responses: { '200': { description: 'Events, newest first', ...jsonBody('MadreActivity') } },
        },
      },
      '/api/madre/compile': {
        post: {
          tags: ['madre'], summary: 'Compile and route a mission without running it', description: 'No mission, run or memory entry is created.', operationId: 'madreCompile',
          requestBody: { required: true, ...jsonBody('MadreCompileRequest') },
          responses: { '200': { description: 'Plan and routing', ...jsonBody('MadreCompileResponse') }, '400': errorResponse('Invalid payload') },
        },
      },
      '/api/madre/memory': {
        get: {
          tags: ['madre'], summary: 'List or search memory', operationId: 'madreMemory',
          parameters: [
            { name: 'q', in: 'query', schema: { type: 'string' } },
            { name: 'type', in: 'query', schema: { type: 'string' } },
            { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 300, default: 100 } },
          ],
          responses: { '200': { description: 'Entries and stats', ...jsonBody('MadreMemory') }, '400': errorResponse('Invalid query') },
        },
        post: {
          tags: ['madre'], summary: 'Store something you tell MADRE', description: 'Never stored as verified unless a reference is given.', operationId: 'madreRemember',
          requestBody: { required: true, ...jsonBody('MadreRememberRequest') },
          responses: { '201': { description: 'Stored, with any adjustments made', ...jsonBody('MadreRememberResponse') }, '400': errorResponse('Invalid payload') },
        },
      },
      '/api/madre/memory/{id}': {
        delete: {
          tags: ['madre'], summary: 'Forget an entry', operationId: 'madreForget',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'Deleted', ...jsonBody('MadreForget') }, '404': errorResponse('No such entry') },
        },
      },
      '/api/madre/budget': {
        get: { tags: ['madre'], summary: 'Budget limits and the cost so far', operationId: 'madreBudget', responses: { '200': { description: 'Budget', ...jsonBody('MadreBudget') } } },
        patch: {
          tags: ['madre'], summary: 'Change budget limits (null removes a limit)', operationId: 'madreSetBudget',
          requestBody: { required: true, ...jsonBody('MadreBudgetRequest') },
          responses: { '200': { description: 'Updated budget', ...jsonBody('MadreBudget') }, '400': errorResponse('Invalid payload') },
        },
      },
      '/api/madre/approvals': { get: { tags: ['madre'], summary: 'Pending approvals and input requests', operationId: 'madreApprovals', responses: { '200': { description: 'Pending', ...jsonBody('MadreApprovals') } } } },
      '/api/madre/approvals/{id}/approve': {
        post: {
          tags: ['madre'], summary: 'Approve an action, or supply the requested input in `note`', description: 'When the run has no other pending approval it is queued to continue.', operationId: 'madreApprove',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: { required: false, ...jsonBody('MadreDecisionRequest') },
          responses: { '200': { description: 'Decided', ...jsonBody('MadreDecision') }, '404': errorResponse('No such approval'), '409': errorResponse('Already decided') },
        },
      },
      '/api/madre/approvals/{id}/deny': {
        post: {
          tags: ['madre'], summary: 'Deny an action; only the steps that depend on it are blocked', operationId: 'madreDeny',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: { required: false, ...jsonBody('MadreDecisionRequest') },
          responses: { '200': { description: 'Decided', ...jsonBody('MadreDecision') }, '404': errorResponse('No such approval'), '409': errorResponse('Already decided') },
        },
      },
    },
    components: { schemas },
  };
}
