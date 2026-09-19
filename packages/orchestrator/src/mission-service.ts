/**
 * MissionService — the application layer.
 *
 * Owns the mission lifecycle and the asynchrony contract: creating or running a
 * mission writes the mission, the run and the eight agent rows, enqueues a job,
 * and returns. Nothing in this file awaits agent execution, which is what keeps
 * the HTTP request short.
 */

import {
  MissionAlreadyRunningError,
  MissionNotFoundError,
  deriveTitle,
  newId,
  pipelineOrder,
  systemClock,
  type Clock,
  type CreateAgentExecutionData,
  type CreateMissionInput,
  type JobQueue,
  type ListMissionsQuery,
  type Logger,
  type MissionDetail,
  type MissionId,
  type MissionRun,
  type MissionSummary,
  type Repositories,
  type RunDetail,
  type RunMissionInput,
} from '@acc/domain';
import type { ProviderRegistry } from '@acc/providers';
import { buildAssignment } from './prompts.ts';

export interface CreateMissionResult {
  mission: MissionDetail;
  /** Null when `autoStart` was false, so the caller knows nothing was queued. */
  run: MissionRun | null;
}

export class MissionService {
  private readonly repos: Repositories;
  private readonly providers: ProviderRegistry;
  private readonly queue: JobQueue;
  private readonly clock: Clock;
  private readonly logger: Logger;

  constructor(deps: {
    repositories: Repositories;
    providers: ProviderRegistry;
    queue: JobQueue;
    logger: Logger;
    clock?: Clock;
  }) {
    this.repos = deps.repositories;
    this.providers = deps.providers;
    this.queue = deps.queue;
    this.logger = deps.logger.child({ component: 'mission-service' });
    this.clock = deps.clock ?? systemClock;
  }

  async create(input: CreateMissionInput): Promise<CreateMissionResult> {
    // Resolve the provider BEFORE writing anything: a bad provider id should be
    // a 400 with no mission created, not a mission that fails a second later.
    const { provider, model } = this.providers.resolve(input.providerId, input.model);

    const now = this.clock.now();
    const mission = await this.repos.missions.create({
      id: newId(),
      prompt: input.prompt,
      title: deriveTitle(input.prompt),
      createdAt: now,
    });

    this.logger.info('mission created', { missionId: mission.id });

    if (input.autoStart === false) {
      return { mission: { mission, runs: [] }, run: null };
    }

    const run = await this.startRun(mission.id, mission.prompt, provider.id, model);
    const detail = await this.requireDetail(mission.id);
    return { mission: detail, run };
  }

  async run(missionId: MissionId, input: RunMissionInput): Promise<MissionRun> {
    const mission = await this.repos.missions.findById(missionId);
    if (!mission) throw new MissionNotFoundError(missionId);

    const active = await this.repos.runs.findActiveByMission(missionId);
    if (active) throw new MissionAlreadyRunningError(missionId);

    const { provider, model } = this.providers.resolve(input.providerId, input.model);
    return this.startRun(missionId, mission.prompt, provider.id, model);
  }

  async get(missionId: MissionId): Promise<MissionDetail> {
    return this.requireDetail(missionId);
  }

  async list(query: ListMissionsQuery): Promise<{ items: MissionSummary[]; total: number }> {
    const [items, total] = await Promise.all([
      this.repos.missions.list(query),
      this.repos.missions.count(query.status !== undefined ? { status: query.status } : {}),
    ]);
    return { items, total };
  }

  /** Aggregate numbers for the dashboard, computed from a single list pass. */
  async stats(): Promise<{
    total: number;
    pending: number;
    running: number;
    completed: number;
    failed: number;
  }> {
    const [total, pending, running, completed, failed] = await Promise.all([
      this.repos.missions.count(),
      this.repos.missions.count({ status: 'pending' }),
      this.repos.missions.count({ status: 'running' }),
      this.repos.missions.count({ status: 'completed' }),
      this.repos.missions.count({ status: 'failed' }),
    ]);
    return { total, pending, running, completed, failed };
  }

  /**
   * Create the run plus its agent rows and hand it to the queue.
   *
   * Agent rows are written UP FRONT, all eight as `pending`. That is what lets
   * the UI draw the whole pipeline the instant the mission is created instead
   * of having agents pop into existence one by one.
   */
  private async startRun(
    missionId: MissionId,
    missionPrompt: string,
    providerId: string,
    model: string,
  ): Promise<MissionRun> {
    const now = this.clock.now();

    // One transaction: the run, its eight agent rows and the mission status
    // land together or not at all. A run persisted without agents would be
    // picked up by the orchestrator and "completed" having done no work.
    const run = await this.repos.transaction(async (repos) => {
      const attempt = (await repos.runs.latestAttempt(missionId)) + 1;

      const created = await repos.runs.create({
        id: newId(),
        missionId,
        attempt,
        providerId,
        model,
        createdAt: now,
      });

      const rows: CreateAgentExecutionData[] = pipelineOrder().map((definition, index) => ({
        id: newId(),
        missionId,
        runId: created.id,
        agentId: definition.id,
        name: definition.name,
        orderIndex: index,
        task: buildAssignment(definition, missionPrompt),
      }));

      await repos.agents.createMany(rows);
      await repos.missions.updateStatus(missionId, 'pending', now);
      return created;
    });

    // Enqueued only after the transaction commits, so a worker can never pick
    // up a run that was rolled back.
    await this.queue.enqueue({ type: 'execute-run', runId: run.id, missionId });

    this.logger.info('run queued', { missionId, runId: run.id, attempt: run.attempt });
    return run;
  }

  private async requireDetail(missionId: MissionId): Promise<MissionDetail> {
    const detail = await this.repos.missions.findDetail(missionId);
    if (!detail) throw new MissionNotFoundError(missionId);
    return detail;
  }
}

/** Newest run first — what the detail screen shows at the top. */
export function sortRunsNewestFirst(runs: readonly RunDetail[]): RunDetail[] {
  return [...runs].sort((a, b) => b.run.attempt - a.run.attempt);
}
