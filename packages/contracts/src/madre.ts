/**
 * MADRE API contract.
 *
 * MADRE's documents (plans, run states, registries…) are deeply nested and are
 * defined once, as TypeScript types, in `@acc/madre/types`. Repeating them as
 * Zod trees would create a second definition to keep in sync, so the schemas
 * here check the *envelope* of each response and type its documents with
 * `document<T>()`. The server sends exactly those types; the client trusts the
 * envelope and gets the inner types at compile time.
 */

import { z } from 'zod';

import type {
  AgentSpec,
  ApprovalRequest,
  AuditEvent,
  Budget,
  CostSummary,
  MadreSnapshot,
  MemoryEntry,
  MissionPlan,
  PermissionLevel,
  PermissionMode,
  MissionTrace,
  ProviderProfile,
  RoutingDecision,
  ToolSpec,
  WorldModel,
} from '@acc/madre/types';

/** A JSON object typed as `T`. Shallow at runtime, exact at compile time. */
function document<T>(): z.ZodType<T> {
  return z.custom<T>((value) => typeof value === 'object' && value !== null && !Array.isArray(value), 'Expected a JSON object.');
}

const pipelineReportSchema = z.object({
  stages: z.array(z.object({ id: z.string(), title: z.string(), group: z.string(), status: z.enum(['ready', 'partial', 'blocked']), missing: z.array(z.string()), note: z.string(), needsApproval: z.boolean(), blockedByPolicy: z.boolean() })),
  ready: z.number().int(),
  partial: z.number().int(),
  blocked: z.number().int(),
  summary: z.string(),
});

export const missionModeSchema = z.enum(['classic', 'madre']);

export const madreOverviewSchema = z.object({
  world: document<WorldModel>(),
  pendingApprovals: z.number().int(),
  recent: z.array(document<AuditEvent>()),
  pipelines: z.object({ content: pipelineReportSchema, media: pipelineReportSchema }),
});

export const madreAgentsResponseSchema = z.object({ items: z.array(document<AgentSpec>()) });
export const madreProvidersResponseSchema = z.object({ items: z.array(document<ProviderProfile>()) });

/** `trace` is null when the mission has no run yet. */
export const madreTraceResponseSchema = z.object({ trace: document<MissionTrace>().nullable() });
export const madreToolsResponseSchema = z.object({ items: z.array(document<ToolSpec>()) });
export const madrePermissionsResponseSchema = z.object({ modes: z.record(z.string(), z.string()) as unknown as z.ZodType<Record<PermissionLevel, PermissionMode>> });
export const madreActivityResponseSchema = z.object({ items: z.array(document<AuditEvent>()) });

export const madreCompileRequestSchema = z.object({ prompt: z.string().trim().min(1).max(4000) });
export const madreCompileResponseSchema = z.object({
  plan: document<MissionPlan>(),
  routing: z.array(document<RoutingDecision>()),
});

const memoryStatsSchema = z.object({ total: z.number().int(), verified: z.number().int(), lessons: z.number().int(), byType: z.record(z.string(), z.number().int()) });
export const madreMemoryResponseSchema = z.object({ items: z.array(document<MemoryEntry>()), stats: memoryStatsSchema });
export const madreRememberRequestSchema = z.object({
  title: z.string().trim().min(1).max(160),
  content: z.string().trim().min(1).max(8000),
  type: z.enum(['user_context', 'project_context', 'mission_history', 'fact', 'decision', 'preference', 'result', 'lesson', 'external_source', 'temporary']).optional(),
  scope: z.enum(['user', 'project', 'mission', 'session']).optional(),
  ref: z.string().trim().max(500).optional(),
});
export const madreRememberResponseSchema = z.object({ entry: document<MemoryEntry>(), adjustments: z.array(z.string()) });
export const madreForgetResponseSchema = z.object({ deleted: z.boolean() });

export const madreBudgetRequestSchema = z.object({
  perMissionUsd: z.number().min(0).nullable().optional(),
  dailyUsd: z.number().min(0).nullable().optional(),
  monthlyUsd: z.number().min(0).nullable().optional(),
  onExceed: z.enum(['block', 'fallback_local', 'ask']).optional(),
});
export const madreBudgetResponseSchema = z.object({ budget: document<Budget>(), cost: document<CostSummary>().optional() });

export const madreApprovalsResponseSchema = z.object({ items: z.array(document<ApprovalRequest>()) });
export const madreDecisionRequestSchema = z.object({ note: z.string().max(8000).optional() });
export const madreDecisionResponseSchema = z.object({ approval: document<ApprovalRequest>() });

export const madreSnapshotSchema = document<MadreSnapshot>();
export const cancelMissionResponseSchema = z.object({ cancelled: z.boolean() });

export type MadreOverview = z.infer<typeof madreOverviewSchema>;
export type MadreMemoryResponse = z.infer<typeof madreMemoryResponseSchema>;
export type MadreCompileResponse = z.infer<typeof madreCompileResponseSchema>;
export type MadreBudgetRequest = z.infer<typeof madreBudgetRequestSchema>;
export type MadreRememberRequest = z.infer<typeof madreRememberRequestSchema>;
export type MadrePipelineReport = z.infer<typeof pipelineReportSchema>;

// The document types, re-exported so the web app imports everything from one place.
export type {
  AgentSpec as MadreAgentSpec,
  ApprovalRequest as MadreApproval,
  AuditEvent as MadreAuditEvent,
  Blocker as MadreBlocker,
  Budget as MadreBudget,
  CostSummary as MadreCostSummary,
  ExecutionResult as MadreExecutionResult,
  MadreRunState,
  MadreSnapshot,
  MemoryEntry as MadreMemoryEntry,
  MissionPlan as MadrePlan,
  MissionStep as MadreStep,
  NextAction as MadreNextAction,
  PermissionLevel as MadrePermissionLevel,
  PermissionMode as MadrePermissionMode,
  MissionTrace as MadreTrace,
  ProviderProfile as MadreProvider,
  QAResult as MadreQAResult,
  QAVerdict as MadreQAVerdict,
  RoutingDecision as MadreRouting,
  StepState as MadreStepState,
  StepStatus as MadreStepStatus,
  ToolSpec as MadreTool,
  WorldModel as MadreWorldModel,
} from '@acc/madre/types';
