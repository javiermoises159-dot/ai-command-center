/**
 * Outbound ports. Every adapter (in-memory, Drizzle/Postgres, in-process queue,
 * pg-boss later) implements these; the application layer depends only on them.
 */

import type {
  AgentExecution,
  AgentExecutionId,
  AgentStatus,
  AgentUsage,
  Mission,
  MissionDetail,
  MissionId,
  MissionRun,
  MissionStatus,
  MissionSummary,
  RunId,
  RunStatus,
} from './types.ts';

// ---------------------------------------------------------------------------
// Repositories
// ---------------------------------------------------------------------------

export interface CreateMissionData {
  id: MissionId;
  prompt: string;
  title: string;
  createdAt: Date;
}

export interface CreateRunData {
  id: RunId;
  missionId: MissionId;
  attempt: number;
  providerId: string;
  model: string;
  createdAt: Date;
}

export interface CreateAgentExecutionData {
  id: AgentExecutionId;
  missionId: MissionId;
  runId: RunId;
  agentId: AgentExecution['agentId'];
  name: string;
  orderIndex: number;
  task: string;
}

export interface ListMissionsOptions {
  limit?: number;
  offset?: number;
  status?: MissionStatus;
}

export interface MissionRepository {
  create(data: CreateMissionData): Promise<Mission>;
  findById(id: MissionId): Promise<Mission | null>;
  /** Mission plus every run and agent execution, ordered newest run first. */
  findDetail(id: MissionId): Promise<MissionDetail | null>;
  list(options?: ListMissionsOptions): Promise<MissionSummary[]>;
  count(options?: Pick<ListMissionsOptions, 'status'>): Promise<number>;
  updateStatus(id: MissionId, status: MissionStatus, at: Date): Promise<void>;
  setFinalResult(id: MissionId, finalResult: string | null, status: MissionStatus, at: Date): Promise<void>;
}

export interface RunRepository {
  create(data: CreateRunData): Promise<MissionRun>;
  findById(id: RunId): Promise<MissionRun | null>;
  listByMission(missionId: MissionId): Promise<MissionRun[]>;
  /** Highest attempt number recorded for a mission, 0 when it has never run. */
  latestAttempt(missionId: MissionId): Promise<number>;
  /** Any run still in `pending` or `running` for this mission. */
  findActiveByMission(missionId: MissionId): Promise<MissionRun | null>;
  markStarted(id: RunId, at: Date): Promise<void>;
  markFinished(
    id: RunId,
    status: Extract<RunStatus, 'completed' | 'failed'>,
    at: Date,
    payload: { finalResult?: string | null; error?: string | null },
  ): Promise<void>;
  /** Used on boot to close runs orphaned by a crash or redeploy. */
  findUnfinished(): Promise<MissionRun[]>;
}

export interface AgentExecutionRepository {
  createMany(data: readonly CreateAgentExecutionData[]): Promise<AgentExecution[]>;
  listByRun(runId: RunId): Promise<AgentExecution[]>;
  findById(id: AgentExecutionId): Promise<AgentExecution | null>;
  markStarted(id: AgentExecutionId, at: Date): Promise<void>;
  markCompleted(id: AgentExecutionId, result: string, usage: AgentUsage, at: Date): Promise<void>;
  markFailed(id: AgentExecutionId, error: string, at: Date): Promise<void>;
  /** Bulk-close agents that never ran because the pipeline aborted. */
  markRemainingSkipped(runId: RunId, at: Date): Promise<number>;
  countByStatus(runId: RunId): Promise<Record<AgentStatus, number>>;
}

/** The three repositories, grouped so the composition root passes one object. */
export interface Repositories {
  missions: MissionRepository;
  runs: RunRepository;
  agents: AgentExecutionRepository;
  /** Release pools/connections. Safe to call more than once. */
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Job queue
// ---------------------------------------------------------------------------

/**
 * The only job type today. Kept as a discriminated union so adding
 * `{ type: 'retry-agent' }` later does not change the port's shape.
 */
export type Job = { type: 'execute-run'; runId: RunId; missionId: MissionId };

export type JobHandler = (job: Job) => Promise<void>;

/**
 * Deliberately minimal so an in-process implementation and a durable one
 * (pg-boss, BullMQ) can both satisfy it.
 */
export interface JobQueue {
  /** Register the worker. Must be called before `start`. */
  process(handler: JobHandler): void;
  /** Accept a job. Returns as soon as the job is durably accepted, not run. */
  enqueue(job: Job): Promise<void>;
  start(): void;
  /** Stop accepting work and wait for in-flight jobs, up to `timeoutMs`. */
  stop(timeoutMs?: number): Promise<void>;
  /** Jobs accepted but not yet finished. Exposed for health checks and tests. */
  size(): number;
  /** Resolves when the queue has no pending or in-flight jobs. Used by tests. */
  drain(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Ambient services
// ---------------------------------------------------------------------------

/** Injected so tests can freeze time instead of sleeping. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silentLogger;
  },
};
