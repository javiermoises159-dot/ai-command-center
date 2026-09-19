/**
 * Core entities and state machine of AI Command Center.
 *
 * This module is intentionally dependency-free: the domain must not know about
 * Express, Drizzle, Zod, or any AI vendor SDK. Every outward interaction goes
 * through a port declared in `./ports.ts` or `./provider.ts`.
 */

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

export type MissionId = string;
export type RunId = string;
export type AgentExecutionId = string;

/** Stable identifier of an agent definition in the catalog. */
export type AgentId =
  | 'strategy'
  | 'research'
  | 'code'
  | 'design'
  | 'marketing'
  | 'finance'
  | 'qa'
  | 'integrator';

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

export const MISSION_STATUSES = ['pending', 'running', 'completed', 'failed'] as const;
export type MissionStatus = (typeof MISSION_STATUSES)[number];

export const RUN_STATUSES = ['pending', 'running', 'completed', 'failed'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const AGENT_STATUSES = ['pending', 'running', 'completed', 'failed', 'skipped'] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

/**
 * Allowed transitions. Anything not listed is rejected by `assertTransition`,
 * which keeps a half-written orchestrator from silently corrupting a run.
 *
 * `skipped` exists so that a hard abort (QA or Integrator failure) can close
 * out the agents that never got their turn, instead of leaving them `pending`
 * forever and making a finished run look like it is still working.
 */
const AGENT_TRANSITIONS: Record<AgentStatus, readonly AgentStatus[]> = {
  pending: ['running', 'skipped'],
  running: ['completed', 'failed'],
  completed: [],
  failed: [],
  skipped: [],
};

const RUN_TRANSITIONS: Record<RunStatus, readonly RunStatus[]> = {
  pending: ['running', 'failed'],
  running: ['completed', 'failed'],
  completed: [],
  failed: [],
};

export function canTransitionAgent(from: AgentStatus, to: AgentStatus): boolean {
  return AGENT_TRANSITIONS[from].includes(to);
}

export function canTransitionRun(from: RunStatus, to: RunStatus): boolean {
  return RUN_TRANSITIONS[from].includes(to);
}

/** True once a status can no longer change. */
export function isTerminalAgentStatus(status: AgentStatus): boolean {
  return AGENT_TRANSITIONS[status].length === 0;
}

export function isTerminalRunStatus(status: RunStatus): boolean {
  return RUN_TRANSITIONS[status].length === 0;
}

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

export interface Mission {
  id: MissionId;
  /** The raw mission statement written by the user. */
  prompt: string;
  /** Short human label derived from the prompt, for lists and cards. */
  title: string;
  status: MissionStatus;
  /** Markdown produced by the Integrator agent. Null until a run completes. */
  finalResult: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface MissionRun {
  id: RunId;
  missionId: MissionId;
  /** 1-based; a mission can be re-run any number of times. */
  attempt: number;
  status: RunStatus;
  /** Which provider adapter executed this run (e.g. "mock"). */
  providerId: string;
  model: string;
  finalResult: string | null;
  /** Populated when the run itself fails (not when a single agent fails). */
  error: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}

export interface AgentExecution {
  id: AgentExecutionId;
  missionId: MissionId;
  runId: RunId;
  agentId: AgentId;
  /** Display name, denormalised so historical runs survive catalog renames. */
  name: string;
  /** Execution order inside the run, 0-based. */
  orderIndex: number;
  status: AgentStatus;
  /** The prompt this agent was asked to work on. */
  task: string;
  /** Markdown output. Null unless status === 'completed'. */
  result: string | null;
  /** Human-readable failure reason. Null unless status === 'failed'. */
  error: string | null;
  /** Provider telemetry, present once the call returns. */
  usage: AgentUsage | null;
  startedAt: Date | null;
  completedAt: Date | null;
}

export interface AgentUsage {
  provider: string;
  model: string;
  requestId: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  latencyMs: number;
}

// ---------------------------------------------------------------------------
// Aggregates returned by the read side
// ---------------------------------------------------------------------------

/** A run plus the agent executions that belong to it. */
export interface RunDetail {
  run: MissionRun;
  agents: AgentExecution[];
}

/** Everything the mission detail screen needs, in one shot. */
export interface MissionDetail {
  mission: Mission;
  runs: RunDetail[];
}

/** Row shape for the mission list / history screens. */
export interface MissionSummary {
  mission: Mission;
  runCount: number;
  latestRun: MissionRun | null;
  agentCounts: Record<AgentStatus, number>;
}

// ---------------------------------------------------------------------------
// Derived helpers
// ---------------------------------------------------------------------------

export function emptyAgentCounts(): Record<AgentStatus, number> {
  return { pending: 0, running: 0, completed: 0, failed: 0, skipped: 0 };
}

export function countAgents(agents: readonly AgentExecution[]): Record<AgentStatus, number> {
  const counts = emptyAgentCounts();
  for (const agent of agents) counts[agent.status] += 1;
  return counts;
}

/**
 * Progress of a run as a 0..1 fraction. `skipped` counts as settled so that an
 * aborted run does not show a progress bar frozen below 100%.
 */
export function runProgress(agents: readonly AgentExecution[]): number {
  if (agents.length === 0) return 0;
  const settled = agents.filter((a) => isTerminalAgentStatus(a.status)).length;
  return settled / agents.length;
}
