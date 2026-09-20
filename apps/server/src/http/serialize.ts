/**
 * Wire serialisation.
 *
 * Dates become ISO strings and nothing internal leaks. These shapes are the
 * API contract; `@acc/contracts` publishes the identical shapes as Zod schemas
 * for the OpenAPI document and the typed client, and `contracts/parity.test.ts`
 * asserts the two never drift.
 */

import {
  AGENT_CATALOG,
  runProgress,
  type AgentExecution,
  type AgentStatus,
  type Mission,
  type MissionDetail,
  type MissionRun,
  type MissionSummary,
  type ProviderDescriptor,
  type RunDetail,
} from '@acc/domain';

export interface MissionDTO {
  id: string;
  prompt: string;
  title: string;
  status: string;
  finalResult: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentExecutionDTO {
  id: string;
  missionId: string;
  runId: string;
  agentId: string;
  name: string;
  orderIndex: number;
  status: AgentStatus;
  task: string;
  result: string | null;
  error: string | null;
  usage: {
    provider: string;
    model: string;
    requestId: string;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    latencyMs: number;
  } | null;
  startedAt: string | null;
  completedAt: string | null;
  /** Wall-clock duration in ms once both timestamps exist. */
  durationMs: number | null;
}

export interface RunDTO {
  id: string;
  missionId: string;
  attempt: number;
  status: string;
  providerId: string;
  model: string;
  finalResult: string | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface RunDetailDTO extends RunDTO {
  agents: AgentExecutionDTO[];
  /** 0..1, with skipped agents counted as settled. */
  progress: number;
}

export interface MissionDetailDTO extends MissionDTO {
  runs: RunDetailDTO[];
}

export interface MissionSummaryDTO extends MissionDTO {
  runCount: number;
  latestRun: RunDTO | null;
  agentCounts: Record<AgentStatus, number>;
}

export interface AgentDefinitionDTO {
  id: string;
  name: string;
  role: string;
  kind: string;
  order: number;
  deliverable: string;
  accent: string;
}

export interface ApiErrorDTO {
  error: {
    code: string;
    message: string;
    issues: { path: string; message: string }[];
  };
}

function iso(date: Date | null): string | null {
  return date === null ? null : date.toISOString();
}

export function serializeMission(mission: Mission): MissionDTO {
  return {
    id: mission.id,
    prompt: mission.prompt,
    title: mission.title,
    status: mission.status,
    finalResult: mission.finalResult,
    createdAt: mission.createdAt.toISOString(),
    updatedAt: mission.updatedAt.toISOString(),
  };
}

export function serializeRun(run: MissionRun): RunDTO {
  return {
    id: run.id,
    missionId: run.missionId,
    attempt: run.attempt,
    status: run.status,
    providerId: run.providerId,
    model: run.model,
    finalResult: run.finalResult,
    error: run.error,
    createdAt: run.createdAt.toISOString(),
    startedAt: iso(run.startedAt),
    completedAt: iso(run.completedAt),
  };
}

export function serializeAgent(agent: AgentExecution): AgentExecutionDTO {
  const durationMs =
    agent.startedAt !== null && agent.completedAt !== null
      ? agent.completedAt.getTime() - agent.startedAt.getTime()
      : null;

  return {
    id: agent.id,
    missionId: agent.missionId,
    runId: agent.runId,
    agentId: agent.agentId,
    name: agent.name,
    orderIndex: agent.orderIndex,
    status: agent.status,
    task: agent.task,
    result: agent.result,
    error: agent.error,
    usage: agent.usage,
    startedAt: iso(agent.startedAt),
    completedAt: iso(agent.completedAt),
    durationMs,
  };
}

export function serializeRunDetail(detail: RunDetail): RunDetailDTO {
  return {
    ...serializeRun(detail.run),
    agents: detail.agents.map(serializeAgent),
    progress: runProgress(detail.agents),
  };
}

export function serializeMissionDetail(detail: MissionDetail): MissionDetailDTO {
  return {
    ...serializeMission(detail.mission),
    runs: detail.runs.map(serializeRunDetail),
  };
}

export function serializeMissionSummary(summary: MissionSummary): MissionSummaryDTO {
  return {
    ...serializeMission(summary.mission),
    runCount: summary.runCount,
    latestRun: summary.latestRun === null ? null : serializeRun(summary.latestRun),
    agentCounts: summary.agentCounts,
  };
}

export function serializeAgentCatalog(): AgentDefinitionDTO[] {
  return AGENT_CATALOG.map((agent) => ({
    id: agent.id,
    name: agent.name,
    role: agent.role,
    kind: agent.kind,
    order: agent.order,
    deliverable: agent.deliverable,
    accent: agent.accent,
  }));
}

export function serializeProviders(descriptors: readonly ProviderDescriptor[]): unknown[] {
  return descriptors.map((d) => ({
    id: d.id,
    label: d.label,
    availability: d.availability,
    models: d.models.map((m) => ({
      id: m.id,
      label: m.label,
      contextWindow: m.contextWindow ?? null,
    })),
    note: d.note ?? null,
    // Three different questions: is there an implementation, does it have its
    // credentials, can it be called. Env variable NAMES only — never a value.
    implemented: d.implemented ?? true,
    configured: d.configured ?? d.availability === 'available',
    requires: [...(d.requires ?? [])],
  }));
}
