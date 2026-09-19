/**
 * The published API contract, as Zod schemas.
 *
 * These describe the same shapes the server produces in
 * `apps/server/src/http/serialize.ts`. The server itself validates input with
 * the dependency-free validators in `@acc/domain`; these schemas exist to
 * generate the OpenAPI document and to give the frontend a typed, runtime-
 * checked client.
 *
 * `parity.test.ts` asserts the two definitions agree, so the duplication cannot
 * drift silently.
 */

import { z } from 'zod';

export const missionStatusSchema = z.enum(['pending', 'running', 'completed', 'failed']);
export const runStatusSchema = z.enum(['pending', 'running', 'completed', 'failed']);
export const agentStatusSchema = z.enum(['pending', 'running', 'completed', 'failed', 'skipped']);

export const agentIdSchema = z.enum([
  'strategy',
  'research',
  'code',
  'design',
  'marketing',
  'finance',
  'qa',
  'integrator',
]);

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export const createMissionRequestSchema = z.object({
  prompt: z
    .string()
    .trim()
    .min(12, 'Must be at least 12 characters so the agents have something to work with.')
    .max(4000, 'Must be at most 4000 characters.'),
  providerId: z.string().trim().max(40).optional(),
  model: z.string().trim().max(120).optional(),
  autoStart: z.boolean().optional(),
});

export const runMissionRequestSchema = z.object({
  providerId: z.string().trim().max(40).optional(),
  model: z.string().trim().max(120).optional(),
});

export const listMissionsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  status: missionStatusSchema.optional(),
});

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export const agentUsageSchema = z.object({
  provider: z.string(),
  model: z.string(),
  requestId: z.string(),
  promptTokens: z.number().int(),
  completionTokens: z.number().int(),
  totalTokens: z.number().int(),
  latencyMs: z.number().int(),
});

export const agentExecutionSchema = z.object({
  id: z.string(),
  missionId: z.string(),
  runId: z.string(),
  agentId: agentIdSchema,
  name: z.string(),
  orderIndex: z.number().int(),
  status: agentStatusSchema,
  task: z.string(),
  result: z.string().nullable(),
  error: z.string().nullable(),
  usage: agentUsageSchema.nullable(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  durationMs: z.number().nullable(),
});

export const missionSchema = z.object({
  id: z.string(),
  prompt: z.string(),
  title: z.string(),
  status: missionStatusSchema,
  finalResult: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const runSchema = z.object({
  id: z.string(),
  missionId: z.string(),
  attempt: z.number().int(),
  status: runStatusSchema,
  providerId: z.string(),
  model: z.string(),
  finalResult: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
});

export const runDetailSchema = runSchema.extend({
  agents: z.array(agentExecutionSchema),
  progress: z.number().min(0).max(1),
});

export const missionDetailSchema = missionSchema.extend({
  runs: z.array(runDetailSchema),
});

export const missionSummarySchema = missionSchema.extend({
  runCount: z.number().int(),
  latestRun: runSchema.nullable(),
  agentCounts: z.record(agentStatusSchema, z.number().int()),
});

export const createMissionResponseSchema = z.object({
  mission: missionDetailSchema,
  run: runSchema.nullable(),
});

export const runMissionResponseSchema = z.object({
  run: runSchema,
});

export const listMissionsResponseSchema = z.object({
  items: z.array(missionSummarySchema),
  total: z.number().int(),
  limit: z.number().int(),
  offset: z.number().int(),
});

export const agentDefinitionSchema = z.object({
  id: agentIdSchema,
  name: z.string(),
  role: z.string(),
  kind: z.enum(['worker', 'qa', 'integrator']),
  order: z.number().int(),
  deliverable: z.string(),
  accent: z.string(),
});

export const listAgentsResponseSchema = z.object({
  items: z.array(agentDefinitionSchema),
});

export const providerSchema = z.object({
  id: z.string(),
  label: z.string(),
  availability: z.enum(['available', 'planned']),
  models: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      contextWindow: z.number().int().nullable(),
    }),
  ),
  note: z.string().nullable(),
});

export const listProvidersResponseSchema = z.object({
  items: z.array(providerSchema),
  defaultProviderId: z.string().nullable(),
});

export const statsResponseSchema = z.object({
  total: z.number().int(),
  pending: z.number().int(),
  running: z.number().int(),
  completed: z.number().int(),
  failed: z.number().int(),
});

export const healthResponseSchema = z.object({
  status: z.literal('ok'),
  version: z.string(),
  provider: z.string().nullable(),
  time: z.string(),
});

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    issues: z.array(z.object({ path: z.string(), message: z.string() })),
  }),
});

// ---------------------------------------------------------------------------
// Inferred types — the single source of truth for both client and server.
// ---------------------------------------------------------------------------

export type MissionStatus = z.infer<typeof missionStatusSchema>;
export type RunStatus = z.infer<typeof runStatusSchema>;
export type AgentStatus = z.infer<typeof agentStatusSchema>;
export type AgentId = z.infer<typeof agentIdSchema>;

export type CreateMissionRequest = z.infer<typeof createMissionRequestSchema>;
export type RunMissionRequest = z.infer<typeof runMissionRequestSchema>;
export type ListMissionsQuery = z.infer<typeof listMissionsQuerySchema>;

export type AgentUsage = z.infer<typeof agentUsageSchema>;
export type AgentExecution = z.infer<typeof agentExecutionSchema>;
export type Mission = z.infer<typeof missionSchema>;
export type Run = z.infer<typeof runSchema>;
export type RunDetail = z.infer<typeof runDetailSchema>;
export type MissionDetail = z.infer<typeof missionDetailSchema>;
export type MissionSummary = z.infer<typeof missionSummarySchema>;
export type CreateMissionResponse = z.infer<typeof createMissionResponseSchema>;
export type RunMissionResponse = z.infer<typeof runMissionResponseSchema>;
export type ListMissionsResponse = z.infer<typeof listMissionsResponseSchema>;
export type AgentDefinition = z.infer<typeof agentDefinitionSchema>;
export type ListAgentsResponse = z.infer<typeof listAgentsResponseSchema>;
export type Provider = z.infer<typeof providerSchema>;
export type ListProvidersResponse = z.infer<typeof listProvidersResponseSchema>;
export type StatsResponse = z.infer<typeof statsResponseSchema>;
export type HealthResponse = z.infer<typeof healthResponseSchema>;
export type ApiError = z.infer<typeof apiErrorSchema>;
