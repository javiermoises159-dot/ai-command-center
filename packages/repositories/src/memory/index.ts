/**
 * In-memory repository adapter.
 *
 * Two legitimate uses:
 *  - every orchestration test runs against it, so the core is verified without
 *    a database;
 *  - `PERSISTENCE=memory` boots a working server with no Postgres, for demos.
 *
 * It is NOT the production adapter and does not persist across restarts. The
 * Drizzle/Postgres adapter in `../drizzle` is the default.
 */

import {
  InvalidTransitionError,
  canTransitionAgent,
  canTransitionRun,
  countAgents,
  emptyAgentCounts,
  type AgentExecution,
  type AgentExecutionId,
  type AgentExecutionRepository,
  type AgentStatus,
  type AgentUsage,
  type CreateAgentExecutionData,
  type CreateMissionData,
  type CreateRunData,
  type DocumentQuery,
  type DocumentStore,
  type ListMissionsOptions,
  type Mission,
  type MissionDetail,
  type MissionId,
  type MissionRepository,
  type MissionRun,
  type MissionStatus,
  type MissionSummary,
  type Repositories,
  type RunDetail,
  type RunId,
  type RunRepository,
  type PutDocumentData,
  type RunStatus,
  type StoredDocument,
} from '@acc/domain';

interface Store {
  missions: Map<MissionId, Mission>;
  runs: Map<RunId, MissionRun>;
  agents: Map<AgentExecutionId, AgentExecution>;
  documents: Map<string, StoredDocument>;
}

function createStore(): Store {
  return { missions: new Map(), runs: new Map(), agents: new Map(), documents: new Map() };
}

/** Defensive copy so callers cannot mutate stored state by reference. */
function clone<T>(value: T): T {
  return structuredClone(value);
}

class MemoryMissionRepository implements MissionRepository {
  constructor(private readonly store: Store) {}

  create(data: CreateMissionData): Promise<Mission> {
    const mission: Mission = {
      id: data.id,
      prompt: data.prompt,
      title: data.title,
      status: 'pending',
      finalResult: null,
      createdAt: data.createdAt,
      updatedAt: data.createdAt,
    };
    this.store.missions.set(mission.id, mission);
    return Promise.resolve(clone(mission));
  }

  findById(id: MissionId): Promise<Mission | null> {
    const mission = this.store.missions.get(id);
    return Promise.resolve(mission ? clone(mission) : null);
  }

  findDetail(id: MissionId): Promise<MissionDetail | null> {
    const mission = this.store.missions.get(id);
    if (!mission) return Promise.resolve(null);

    const runs: RunDetail[] = [...this.store.runs.values()]
      .filter((r) => r.missionId === id)
      .sort((a, b) => b.attempt - a.attempt)
      .map((run) => ({
        run: clone(run),
        agents: [...this.store.agents.values()]
          .filter((a) => a.runId === run.id)
          .sort((a, b) => a.orderIndex - b.orderIndex)
          .map(clone),
      }));

    return Promise.resolve({ mission: clone(mission), runs });
  }

  list(options: ListMissionsOptions = {}): Promise<MissionSummary[]> {
    const { limit = 20, offset = 0, status } = options;

    // Newest first. Map iteration is insertion order, so on a same-millisecond
    // tie the later insertion wins (reverse first, then a stable sort).
    const missions = [...this.store.missions.values()]
      .reverse()
      .filter((m) => (status === undefined ? true : m.status === status))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(offset, offset + limit);

    return Promise.resolve(
      missions.map((mission) => {
        const runs = [...this.store.runs.values()]
          .filter((r) => r.missionId === mission.id)
          .sort((a, b) => b.attempt - a.attempt);
        const latestRun = runs[0] ?? null;
        const agents = latestRun
          ? [...this.store.agents.values()].filter((a) => a.runId === latestRun.id)
          : [];

        return {
          mission: clone(mission),
          runCount: runs.length,
          latestRun: latestRun ? clone(latestRun) : null,
          agentCounts: agents.length > 0 ? countAgents(agents) : emptyAgentCounts(),
        };
      }),
    );
  }

  count(options: Pick<ListMissionsOptions, 'status'> = {}): Promise<number> {
    const all = [...this.store.missions.values()];
    return Promise.resolve(
      options.status === undefined ? all.length : all.filter((m) => m.status === options.status).length,
    );
  }

  updateStatus(id: MissionId, status: MissionStatus, at: Date): Promise<void> {
    const mission = this.store.missions.get(id);
    if (mission) {
      mission.status = status;
      mission.updatedAt = at;
    }
    return Promise.resolve();
  }

  setFinalResult(id: MissionId, finalResult: string | null, status: MissionStatus, at: Date): Promise<void> {
    const mission = this.store.missions.get(id);
    if (mission) {
      // Never overwrite a good deliverable with null from a later failed run.
      if (finalResult !== null) mission.finalResult = finalResult;
      mission.status = status;
      mission.updatedAt = at;
    }
    return Promise.resolve();
  }
}

class MemoryRunRepository implements RunRepository {
  constructor(private readonly store: Store) {}

  create(data: CreateRunData): Promise<MissionRun> {
    const run: MissionRun = {
      id: data.id,
      missionId: data.missionId,
      attempt: data.attempt,
      status: 'pending',
      providerId: data.providerId,
      model: data.model,
      finalResult: null,
      error: null,
      createdAt: data.createdAt,
      startedAt: null,
      completedAt: null,
    };
    this.store.runs.set(run.id, run);
    return Promise.resolve(clone(run));
  }

  findById(id: RunId): Promise<MissionRun | null> {
    const run = this.store.runs.get(id);
    return Promise.resolve(run ? clone(run) : null);
  }

  listByMission(missionId: MissionId): Promise<MissionRun[]> {
    return Promise.resolve(
      [...this.store.runs.values()]
        .filter((r) => r.missionId === missionId)
        .sort((a, b) => b.attempt - a.attempt)
        .map(clone),
    );
  }

  latestAttempt(missionId: MissionId): Promise<number> {
    const attempts = [...this.store.runs.values()]
      .filter((r) => r.missionId === missionId)
      .map((r) => r.attempt);
    return Promise.resolve(attempts.length === 0 ? 0 : Math.max(...attempts));
  }

  findActiveByMission(missionId: MissionId): Promise<MissionRun | null> {
    const active = [...this.store.runs.values()].find(
      (r) => r.missionId === missionId && (r.status === 'pending' || r.status === 'running'),
    );
    return Promise.resolve(active ? clone(active) : null);
  }

  markStarted(id: RunId, at: Date): Promise<void> {
    const run = this.store.runs.get(id);
    if (!run) return Promise.resolve();
    this.assertTransition(run.status, 'running');
    run.status = 'running';
    run.startedAt = at;
    return Promise.resolve();
  }

  markFinished(
    id: RunId,
    status: Extract<RunStatus, 'completed' | 'failed'>,
    at: Date,
    payload: { finalResult?: string | null; error?: string | null },
  ): Promise<void> {
    const run = this.store.runs.get(id);
    if (!run) return Promise.resolve();
    this.assertTransition(run.status, status);
    run.status = status;
    run.completedAt = at;
    if (payload.finalResult !== undefined) run.finalResult = payload.finalResult;
    if (payload.error !== undefined) run.error = payload.error;
    return Promise.resolve();
  }

  findUnfinished(): Promise<MissionRun[]> {
    return Promise.resolve(
      [...this.store.runs.values()]
        .filter((r) => r.status === 'pending' || r.status === 'running')
        .map(clone),
    );
  }

  private assertTransition(from: RunStatus, to: RunStatus): void {
    if (!canTransitionRun(from, to)) throw new InvalidTransitionError('run', from, to);
  }
}

class MemoryAgentExecutionRepository implements AgentExecutionRepository {
  constructor(private readonly store: Store) {}

  createMany(data: readonly CreateAgentExecutionData[]): Promise<AgentExecution[]> {
    const created = data.map((row): AgentExecution => {
      const agent: AgentExecution = {
        id: row.id,
        missionId: row.missionId,
        runId: row.runId,
        agentId: row.agentId,
        name: row.name,
        orderIndex: row.orderIndex,
        status: 'pending',
        task: row.task,
        result: null,
        error: null,
        usage: null,
        startedAt: null,
        completedAt: null,
      };
      this.store.agents.set(agent.id, agent);
      return clone(agent);
    });
    return Promise.resolve(created);
  }

  listByRun(runId: RunId): Promise<AgentExecution[]> {
    return Promise.resolve(
      [...this.store.agents.values()]
        .filter((a) => a.runId === runId)
        .sort((a, b) => a.orderIndex - b.orderIndex)
        .map(clone),
    );
  }

  findById(id: AgentExecutionId): Promise<AgentExecution | null> {
    const agent = this.store.agents.get(id);
    return Promise.resolve(agent ? clone(agent) : null);
  }

  markStarted(id: AgentExecutionId, at: Date): Promise<void> {
    const agent = this.store.agents.get(id);
    if (!agent) return Promise.resolve();
    this.assertTransition(agent.status, 'running');
    agent.status = 'running';
    agent.startedAt = at;
    return Promise.resolve();
  }

  markCompleted(id: AgentExecutionId, result: string, usage: AgentUsage, at: Date): Promise<void> {
    const agent = this.store.agents.get(id);
    if (!agent) return Promise.resolve();
    this.assertTransition(agent.status, 'completed');
    agent.status = 'completed';
    agent.result = result;
    agent.usage = usage;
    agent.completedAt = at;
    return Promise.resolve();
  }

  markFailed(id: AgentExecutionId, error: string, at: Date): Promise<void> {
    const agent = this.store.agents.get(id);
    if (!agent) return Promise.resolve();
    this.assertTransition(agent.status, 'failed');
    agent.status = 'failed';
    agent.error = error;
    agent.completedAt = at;
    return Promise.resolve();
  }

  markRemainingSkipped(runId: RunId, at: Date): Promise<number> {
    let count = 0;
    for (const agent of this.store.agents.values()) {
      if (agent.runId === runId && agent.status === 'pending') {
        agent.status = 'skipped';
        agent.completedAt = at;
        count += 1;
      }
    }
    return Promise.resolve(count);
  }

  countByStatus(runId: RunId): Promise<Record<AgentStatus, number>> {
    const agents = [...this.store.agents.values()].filter((a) => a.runId === runId);
    return Promise.resolve(countAgents(agents));
  }

  private assertTransition(from: AgentStatus, to: AgentStatus): void {
    if (!canTransitionAgent(from, to)) throw new InvalidTransitionError('agent', from, to);
  }
}

/** In-memory twin of the Postgres `madre_documents` table. */
class MemoryDocumentStore implements DocumentStore {
  private sequence = 0;
  /** Insertion order breaks ties between documents created in the same instant. */
  private readonly order = new Map<string, number>();

  constructor(private readonly store: Store) {}

  private key(kind: string, id: string): string {
    return `${kind}\u0000${id}`;
  }

  put(data: PutDocumentData): Promise<void> {
    const key = this.key(data.kind, data.id);
    const existing = this.store.documents.get(key);
    if (existing === undefined) this.order.set(key, this.sequence++);
    this.store.documents.set(key, {
      kind: data.kind,
      id: data.id,
      missionId: data.missionId ?? null,
      runId: data.runId ?? null,
      scope: data.scope ?? null,
      createdAt: existing?.createdAt ?? data.at,
      updatedAt: data.at,
      payload: clone(data.payload),
    });
    return Promise.resolve();
  }

  get(kind: string, id: string): Promise<StoredDocument | null> {
    const found = this.store.documents.get(this.key(kind, id));
    return Promise.resolve(found === undefined ? null : clone(found));
  }

  list(query: DocumentQuery = {}): Promise<StoredDocument[]> {
    const kinds = query.kind === undefined ? null : Array.isArray(query.kind) ? query.kind : [query.kind];
    let rows = [...this.store.documents.entries()].filter(([, doc]) => {
      if (kinds !== null && !kinds.includes(doc.kind)) return false;
      if (query.missionId !== undefined && doc.missionId !== query.missionId) return false;
      if (query.runId !== undefined && doc.runId !== query.runId) return false;
      if (query.scope !== undefined && doc.scope !== query.scope) return false;
      return true;
    });
    const direction = query.order === 'desc' ? -1 : 1;
    rows = rows.sort(([ka, a], [kb, b]) => {
      const byTime = a.createdAt.getTime() - b.createdAt.getTime();
      return direction * (byTime !== 0 ? byTime : (this.order.get(ka) ?? 0) - (this.order.get(kb) ?? 0));
    });
    const limited = query.limit === undefined ? rows : rows.slice(0, query.limit);
    return Promise.resolve(limited.map(([, doc]) => clone(doc)));
  }

  remove(kind: string, id: string): Promise<boolean> {
    const key = this.key(kind, id);
    this.order.delete(key);
    return Promise.resolve(this.store.documents.delete(key));
  }

}

export function createMemoryRepositories(): Repositories {
  const store = createStore();
  const set = {
    missions: new MemoryMissionRepository(store),
    runs: new MemoryRunRepository(store),
    agents: new MemoryAgentExecutionRepository(store),
  };

  return {
    ...set,
    documents: new MemoryDocumentStore(store),
    /**
     * NOT atomic, and deliberately not faked to look atomic: implementing
     * rollback would mean snapshotting three Maps on every call to buy
     * durability guarantees this adapter does not otherwise offer. Node runs
     * this single-threaded with no I/O between the writes, so the failure
     * window the transaction exists to close does not arise here. Postgres is
     * where the guarantee is real.
     */
    transaction: (fn) => fn(set),
    close: () => {
      store.missions.clear();
      store.runs.clear();
      store.agents.clear();
      store.documents.clear();
      return Promise.resolve();
    },
  };
}
