/**
 * Row <-> domain entity mapping.
 *
 * Kept separate from the repositories so the column-shape knowledge lives in
 * one place. The usage columns are flattened in the table and reassembled here.
 */

import type { AgentExecution, AgentStatus, AgentUsage, Mission, MissionRun, MissionStatus, RunStatus } from '@acc/domain';
import type { MissionAgentRow, MissionRow, MissionRunRow } from '@acc/database';
import type { AgentId } from '@acc/domain';

export function toMission(row: MissionRow): Mission {
  return {
    id: row.id,
    prompt: row.prompt,
    title: row.title,
    status: row.status as MissionStatus,
    finalResult: row.finalResult,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toRun(row: MissionRunRow): MissionRun {
  return {
    id: row.id,
    missionId: row.missionId,
    attempt: row.attempt,
    status: row.status as RunStatus,
    providerId: row.providerId,
    model: row.model,
    finalResult: row.finalResult,
    error: row.error,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
  };
}

export function toAgent(row: MissionAgentRow): AgentExecution {
  return {
    id: row.id,
    missionId: row.missionId,
    runId: row.runId,
    agentId: row.agentId as AgentId,
    name: row.name,
    orderIndex: row.orderIndex,
    status: row.status as AgentStatus,
    task: row.task,
    result: row.result,
    error: row.error,
    usage: toUsage(row),
    startedAt: row.startedAt,
    completedAt: row.completedAt,
  };
}

function toUsage(row: MissionAgentRow): AgentUsage | null {
  // Every usage column is written together, so one being null means no call
  // has returned yet.
  if (row.usageProvider === null || row.usageModel === null || row.usageRequestId === null) return null;

  return {
    provider: row.usageProvider,
    model: row.usageModel,
    requestId: row.usageRequestId,
    promptTokens: row.usagePromptTokens ?? 0,
    completionTokens: row.usageCompletionTokens ?? 0,
    totalTokens: row.usageTotalTokens ?? 0,
    latencyMs: row.usageLatencyMs ?? 0,
  };
}

export function usageColumns(usage: AgentUsage) {
  return {
    usageProvider: usage.provider,
    usageModel: usage.model,
    usageRequestId: usage.requestId,
    usagePromptTokens: usage.promptTokens,
    usageCompletionTokens: usage.completionTokens,
    usageTotalTokens: usage.totalTokens,
    usageLatencyMs: usage.latencyMs,
  };
}
