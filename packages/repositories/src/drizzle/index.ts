/**
 * Drizzle / PostgreSQL repository adapter — the production persistence layer.
 *
 * Implements the same ports as the in-memory adapter, so the orchestrator and
 * the service cannot tell them apart. Status transitions are enforced in the
 * WHERE clause rather than by reading first and writing second: an UPDATE that
 * matches zero rows is a lost race, not a crash.
 */

import {
  emptyAgentCounts,
  type AgentExecution,
  type AgentExecutionId,
  type AgentExecutionRepository,
  type AgentStatus,
  type AgentUsage,
  type CreateAgentExecutionData,
  type CreateMissionData,
  type CreateRunData,
  type ListMissionsOptions,
  type Mission,
  type MissionDetail,
  type MissionId,
  type MissionRepository,
  type MissionRun,
  type MissionStatus,
  type MissionSummary,
  type Repositories,
  type RepositorySet,
  type RunDetail,
  type RunId,
  type RunRepository,
  type RunStatus,
} from '@acc/domain';
import { missionAgents, missionRuns, missions, type Database } from '@acc/database';
import { and, count, desc, eq, inArray, sql } from 'drizzle-orm';

import { DrizzleDocumentStore } from './documents.ts';
import { toAgent, toMission, toRun, usageColumns } from './mappers.ts';

/**
 * The root Drizzle instance or a transaction handle.
 *
 * Derived from `Database['transaction']` rather than named explicitly, so it
 * tracks drizzle's own generics instead of drifting from them.
 */
type DbLike = Database | Parameters<Parameters<Database['transaction']>[0]>[0];

class DrizzleMissionRepository implements MissionRepository {
  constructor(private readonly db: DbLike) {}

  async create(data: CreateMissionData): Promise<Mission> {
    const [row] = await this.db
      .insert(missions)
      .values({
        id: data.id,
        prompt: data.prompt,
        title: data.title,
        status: 'pending',
        createdAt: data.createdAt,
        updatedAt: data.createdAt,
      })
      .returning();

    if (!row) throw new Error('INSERT into missions returned no row.');
    return toMission(row);
  }

  async findById(id: MissionId): Promise<Mission | null> {
    const [row] = await this.db.select().from(missions).where(eq(missions.id, id)).limit(1);
    return row ? toMission(row) : null;
  }

  async findDetail(id: MissionId): Promise<MissionDetail | null> {
    const mission = await this.findById(id);
    if (!mission) return null;

    const runRows = await this.db
      .select()
      .from(missionRuns)
      .where(eq(missionRuns.missionId, id))
      .orderBy(desc(missionRuns.attempt));

    if (runRows.length === 0) return { mission, runs: [] };

    // One query for every agent of every run, grouped in memory: a mission has
    // a handful of runs, so this is a fixed 3 queries rather than N+1.
    const agentRows = await this.db
      .select()
      .from(missionAgents)
      .where(
        inArray(
          missionAgents.runId,
          runRows.map((r) => r.id),
        ),
      )
      .orderBy(missionAgents.orderIndex);

    const byRun = new Map<string, AgentExecution[]>();
    for (const row of agentRows) {
      const list = byRun.get(row.runId) ?? [];
      list.push(toAgent(row));
      byRun.set(row.runId, list);
    }

    const runs: RunDetail[] = runRows.map((row) => ({
      run: toRun(row),
      agents: byRun.get(row.id) ?? [],
    }));

    return { mission, runs };
  }

  async list(options: ListMissionsOptions = {}): Promise<MissionSummary[]> {
    const { limit = 20, offset = 0, status } = options;

    const missionRows = await this.db
      .select()
      .from(missions)
      .where(status === undefined ? undefined : eq(missions.status, status))
      .orderBy(desc(missions.createdAt))
      .limit(limit)
      .offset(offset);

    if (missionRows.length === 0) return [];
    const missionIds = missionRows.map((m) => m.id);

    const runRows = await this.db
      .select()
      .from(missionRuns)
      .where(inArray(missionRuns.missionId, missionIds))
      .orderBy(desc(missionRuns.attempt));

    const latestRunByMission = new Map<string, (typeof runRows)[number]>();
    const runCountByMission = new Map<string, number>();
    for (const run of runRows) {
      runCountByMission.set(run.missionId, (runCountByMission.get(run.missionId) ?? 0) + 1);
      // Rows arrive newest-attempt first, so the first one wins.
      if (!latestRunByMission.has(run.missionId)) latestRunByMission.set(run.missionId, run);
    }

    const latestRunIds = [...latestRunByMission.values()].map((r) => r.id);
    const countsByRun = new Map<string, Record<AgentStatus, number>>();

    if (latestRunIds.length > 0) {
      const statusRows = await this.db
        .select({
          runId: missionAgents.runId,
          status: missionAgents.status,
          total: count(),
        })
        .from(missionAgents)
        .where(inArray(missionAgents.runId, latestRunIds))
        .groupBy(missionAgents.runId, missionAgents.status);

      for (const row of statusRows) {
        const counts = countsByRun.get(row.runId) ?? emptyAgentCounts();
        counts[row.status as AgentStatus] = Number(row.total);
        countsByRun.set(row.runId, counts);
      }
    }

    return missionRows.map((row) => {
      const latest = latestRunByMission.get(row.id);
      return {
        mission: toMission(row),
        runCount: runCountByMission.get(row.id) ?? 0,
        latestRun: latest ? toRun(latest) : null,
        agentCounts: (latest ? countsByRun.get(latest.id) : undefined) ?? emptyAgentCounts(),
      };
    });
  }

  async count(options: Pick<ListMissionsOptions, 'status'> = {}): Promise<number> {
    const [row] = await this.db
      .select({ total: count() })
      .from(missions)
      .where(options.status === undefined ? undefined : eq(missions.status, options.status));
    return Number(row?.total ?? 0);
  }

  async updateStatus(id: MissionId, status: MissionStatus, at: Date): Promise<void> {
    await this.db.update(missions).set({ status, updatedAt: at }).where(eq(missions.id, id));
  }

  async setFinalResult(
    id: MissionId,
    finalResult: string | null,
    status: MissionStatus,
    at: Date,
  ): Promise<void> {
    // A null result means "this run produced nothing", not "erase what is
    // stored". Omitting the column leaves an earlier run's deliverable intact.
    await this.db
      .update(missions)
      .set({
        ...(finalResult === null ? {} : { finalResult }),
        status,
        updatedAt: at,
      })
      .where(eq(missions.id, id));
  }
}

class DrizzleRunRepository implements RunRepository {
  constructor(private readonly db: DbLike) {}

  async create(data: CreateRunData): Promise<MissionRun> {
    const [row] = await this.db
      .insert(missionRuns)
      .values({
        id: data.id,
        missionId: data.missionId,
        attempt: data.attempt,
        status: 'pending',
        providerId: data.providerId,
        model: data.model,
        createdAt: data.createdAt,
      })
      .returning();

    if (!row) throw new Error('INSERT into mission_runs returned no row.');
    return toRun(row);
  }

  async findById(id: RunId): Promise<MissionRun | null> {
    const [row] = await this.db.select().from(missionRuns).where(eq(missionRuns.id, id)).limit(1);
    return row ? toRun(row) : null;
  }

  async listByMission(missionId: MissionId): Promise<MissionRun[]> {
    const rows = await this.db
      .select()
      .from(missionRuns)
      .where(eq(missionRuns.missionId, missionId))
      .orderBy(desc(missionRuns.attempt));
    return rows.map(toRun);
  }

  async latestAttempt(missionId: MissionId): Promise<number> {
    const [row] = await this.db
      .select({ max: sql<number | null>`max(${missionRuns.attempt})` })
      .from(missionRuns)
      .where(eq(missionRuns.missionId, missionId));
    return Number(row?.max ?? 0);
  }

  async findActiveByMission(missionId: MissionId): Promise<MissionRun | null> {
    const [row] = await this.db
      .select()
      .from(missionRuns)
      .where(
        and(eq(missionRuns.missionId, missionId), inArray(missionRuns.status, ['pending', 'running'])),
      )
      .orderBy(desc(missionRuns.attempt))
      .limit(1);
    return row ? toRun(row) : null;
  }

  async markStarted(id: RunId, at: Date): Promise<void> {
    await this.db
      .update(missionRuns)
      .set({ status: 'running', startedAt: at })
      // Guard in SQL: only a pending run may start, so a duplicate worker
      // cannot restart a run that is already going.
      .where(and(eq(missionRuns.id, id), eq(missionRuns.status, 'pending')));
  }

  async markFinished(
    id: RunId,
    status: Extract<RunStatus, 'completed' | 'failed'>,
    at: Date,
    payload: { finalResult?: string | null; error?: string | null },
  ): Promise<void> {
    await this.db
      .update(missionRuns)
      .set({
        status,
        completedAt: at,
        ...(payload.finalResult !== undefined ? { finalResult: payload.finalResult } : {}),
        ...(payload.error !== undefined ? { error: payload.error } : {}),
      })
      .where(and(eq(missionRuns.id, id), inArray(missionRuns.status, ['pending', 'running'])));
  }

  async findUnfinished(): Promise<MissionRun[]> {
    const rows = await this.db
      .select()
      .from(missionRuns)
      .where(inArray(missionRuns.status, ['pending', 'running']));
    return rows.map(toRun);
  }
}

class DrizzleAgentExecutionRepository implements AgentExecutionRepository {
  constructor(private readonly db: DbLike) {}

  async createMany(data: readonly CreateAgentExecutionData[]): Promise<AgentExecution[]> {
    if (data.length === 0) return [];

    const rows = await this.db
      .insert(missionAgents)
      .values(
        data.map((row) => ({
          id: row.id,
          missionId: row.missionId,
          runId: row.runId,
          agentId: row.agentId,
          name: row.name,
          orderIndex: row.orderIndex,
          status: 'pending' as const,
          task: row.task,
        })),
      )
      .returning();

    return rows.map(toAgent);
  }

  async listByRun(runId: RunId): Promise<AgentExecution[]> {
    const rows = await this.db
      .select()
      .from(missionAgents)
      .where(eq(missionAgents.runId, runId))
      .orderBy(missionAgents.orderIndex);
    return rows.map(toAgent);
  }

  async findById(id: AgentExecutionId): Promise<AgentExecution | null> {
    const [row] = await this.db.select().from(missionAgents).where(eq(missionAgents.id, id)).limit(1);
    return row ? toAgent(row) : null;
  }

  async markStarted(id: AgentExecutionId, at: Date): Promise<void> {
    await this.db
      .update(missionAgents)
      .set({ status: 'running', startedAt: at })
      .where(and(eq(missionAgents.id, id), eq(missionAgents.status, 'pending')));
  }

  async markCompleted(id: AgentExecutionId, result: string, usage: AgentUsage, at: Date): Promise<void> {
    await this.db
      .update(missionAgents)
      .set({ status: 'completed', result, completedAt: at, ...usageColumns(usage) })
      .where(and(eq(missionAgents.id, id), eq(missionAgents.status, 'running')));
  }

  async markFailed(id: AgentExecutionId, error: string, at: Date): Promise<void> {
    await this.db
      .update(missionAgents)
      .set({ status: 'failed', error, completedAt: at })
      .where(and(eq(missionAgents.id, id), eq(missionAgents.status, 'running')));
  }

  async markRemainingSkipped(runId: RunId, at: Date): Promise<number> {
    const rows = await this.db
      .update(missionAgents)
      .set({ status: 'skipped', completedAt: at })
      .where(and(eq(missionAgents.runId, runId), eq(missionAgents.status, 'pending')))
      .returning({ id: missionAgents.id });
    return rows.length;
  }

  async countByStatus(runId: RunId): Promise<Record<AgentStatus, number>> {
    const rows = await this.db
      .select({ status: missionAgents.status, total: count() })
      .from(missionAgents)
      .where(eq(missionAgents.runId, runId))
      .groupBy(missionAgents.status);

    const counts = emptyAgentCounts();
    for (const row of rows) counts[row.status as AgentStatus] = Number(row.total);
    return counts;
  }
}

function buildSet(db: DbLike): RepositorySet {
  return {
    missions: new DrizzleMissionRepository(db),
    runs: new DrizzleRunRepository(db),
    agents: new DrizzleAgentExecutionRepository(db),
  };
}

export function createDrizzleRepositories(db: Database, close: () => Promise<void>): Repositories {
  return {
    ...buildSet(db),
    documents: new DrizzleDocumentStore(db),
    // Real atomicity: a throw inside `fn` rolls back every write it made.
    transaction: (fn) => db.transaction((tx) => fn(buildSet(tx))),
    close,
  };
}
