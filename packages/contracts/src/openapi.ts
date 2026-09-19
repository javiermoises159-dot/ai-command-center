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
    schemas[name] = z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'output' });
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
    },
    components: { schemas },
  };
}
