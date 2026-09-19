/**
 * End-to-end orchestration tests.
 *
 * These drive the real MissionService, the real InProcessJobQueue, the real
 * MissionOrchestrator and the real MockProvider against the in-memory
 * repository adapter. Nothing here is stubbed except the clock and the
 * provider's sleep, so the pipeline these tests exercise is the pipeline the
 * server runs.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import {
  MissionAlreadyRunningError,
  silentLogger,
  type Clock,
  type MissionDetail,
  type Repositories,
} from '@acc/domain';
import { MockProvider, ProviderRegistry } from '@acc/providers';
import { createMemoryRepositories } from '@acc/repositories/memory';

import { InProcessJobQueue } from './in-process-queue.ts';
import { MissionOrchestrator } from './orchestrator.ts';
import { MissionService } from './mission-service.ts';
import { recoverUnfinishedRuns } from './recovery.ts';

/** Monotonic fake clock: every read advances by a second, so ordering is testable. */
function fakeClock(): Clock {
  let tick = 0;
  return { now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)) };
}

interface Harness {
  repos: Repositories;
  service: MissionService;
  queue: InProcessJobQueue;
  /** Create a mission and wait for its run to finish. */
  runToCompletion(prompt: string): Promise<MissionDetail>;
}

function harness(options: { continueOnWorkerFailure?: boolean } = {}): Harness {
  const repos = createMemoryRepositories();
  const providers = new ProviderRegistry().register(new MockProvider({ sleep: () => Promise.resolve() }), {
    makeDefault: true,
  });
  const queue = new InProcessJobQueue({ logger: silentLogger });
  const clock = fakeClock();

  const orchestrator = new MissionOrchestrator({
    repositories: repos,
    providers,
    logger: silentLogger,
    clock,
    options: {
      continueOnWorkerFailure: options.continueOnWorkerFailure ?? true,
      agentTimeoutMs: 5_000,
    },
  });

  queue.process(async (job) => {
    await orchestrator.execute(job.runId);
  });
  queue.start();

  const service = new MissionService({ repositories: repos, providers, queue, logger: silentLogger, clock });

  return {
    repos,
    service,
    queue,
    async runToCompletion(prompt: string) {
      const created = await service.create({ prompt, autoStart: true });
      await queue.drain();
      return service.get(created.mission.mission.id);
    },
  };
}

describe('mission pipeline — happy path', () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it('creates the mission, one run and all eight agent rows before executing', async () => {
    const created = await h.service.create({ prompt: 'Launch an online cookie store in Italy' });

    // The response is returned BEFORE the agents run: this is the asynchrony contract.
    const runDetail = created.mission.runs[0];
    assert.ok(runDetail, 'a run should have been created');
    assert.equal(runDetail.agents.length, 8);
    assert.deepEqual(
      runDetail.agents.map((a) => a.agentId),
      ['strategy', 'research', 'code', 'design', 'marketing', 'finance', 'qa', 'integrator'],
    );
    assert.ok(
      runDetail.agents.every((a) => a.status === 'pending' || a.status === 'running'),
      'agents should not be finished at creation time',
    );
    assert.equal(created.mission.mission.finalResult, null);
  });

  it('completes every agent and stores the integrator output as the final result', async () => {
    const detail = await h.runToCompletion('Launch an online cookie store in Italy');
    const run = detail.runs[0];
    assert.ok(run);

    assert.equal(detail.mission.status, 'completed');
    assert.equal(run.run.status, 'completed');
    assert.equal(run.agents.filter((a) => a.status === 'completed').length, 8);
    assert.equal(run.agents.filter((a) => a.status !== 'completed').length, 0);

    const integrator = run.agents.find((a) => a.agentId === 'integrator');
    assert.ok(integrator?.result);
    assert.equal(detail.mission.finalResult, integrator.result);
    assert.equal(run.run.finalResult, integrator.result);
    assert.equal(run.run.error, null);
  });

  it('records usage and timing for every agent', async () => {
    const detail = await h.runToCompletion('Launch an online cookie store in Italy');
    const run = detail.runs[0];
    assert.ok(run);

    for (const agent of run.agents) {
      assert.ok(agent.usage, `${agent.agentId} has no usage`);
      assert.equal(agent.usage.provider, 'mock');
      assert.ok(agent.usage.totalTokens > 0);
      assert.ok(agent.startedAt instanceof Date);
      assert.ok(agent.completedAt instanceof Date);
      assert.ok(agent.completedAt.getTime() >= agent.startedAt.getTime());
    }
  });

  it('executes agents strictly in pipeline order', async () => {
    const detail = await h.runToCompletion('Launch an online cookie store in Italy');
    const agents = detail.runs[0]?.agents ?? [];

    const startTimes = agents.map((a) => a.startedAt?.getTime() ?? 0);
    const sorted = [...startTimes].sort((a, b) => a - b);
    assert.deepEqual(startTimes, sorted, 'agents did not start in order');
  });

  it('feeds upstream output into QA and the Integrator', async () => {
    const detail = await h.runToCompletion('Launch an online cookie store in Italy');
    const agents = detail.runs[0]?.agents ?? [];

    const qa = agents.find((a) => a.agentId === 'qa');
    const integrator = agents.find((a) => a.agentId === 'integrator');

    // QA names each specialist it reviewed; the Integrator reproduces their sections.
    assert.match(qa?.result ?? '', /Marketing/);
    assert.match(qa?.result ?? '', /Finance/);
    assert.match(integrator?.result ?? '', /### Strategy/);
    assert.match(integrator?.result ?? '', /### Quality Assurance|QA review/);
  });

  it('stores a readable assignment on every agent row', async () => {
    const created = await h.service.create({ prompt: 'Launch an online cookie store in Italy' });
    for (const agent of created.mission.runs[0]?.agents ?? []) {
      assert.match(agent.task, /^MISSION: Launch an online cookie store in Italy/);
      assert.match(agent.task, /EXPECTED DELIVERABLE:/);
    }
  });
});

describe('mission pipeline — worker failure is survivable', () => {
  it('marks only the failing agent failed and still produces a final result', async () => {
    const h = harness({ continueOnWorkerFailure: true });
    const detail = await h.runToCompletion('Launch an online cookie store in Italy [fail:marketing]');
    const run = detail.runs[0];
    assert.ok(run);

    const marketing = run.agents.find((a) => a.agentId === 'marketing');
    assert.equal(marketing?.status, 'failed');
    assert.match(marketing?.error ?? '', /\[fail:marketing\]/);
    assert.equal(marketing?.result, null);

    // Everything downstream still ran.
    assert.equal(run.agents.filter((a) => a.status === 'completed').length, 7);
    assert.equal(run.agents.filter((a) => a.status === 'skipped').length, 0);

    // The run is failed, but the partial deliverable is kept rather than discarded.
    assert.equal(run.run.status, 'failed');
    assert.equal(detail.mission.status, 'failed');
    assert.match(run.run.error ?? '', /1 agent failed: Marketing/);
    assert.ok(detail.mission.finalResult, 'the integrator brief should still be stored');
  });

  it('tells QA and the Integrator which agent is missing', async () => {
    const h = harness();
    const detail = await h.runToCompletion('Launch an online cookie store in Italy [fail:marketing]');
    const agents = detail.runs[0]?.agents ?? [];

    const qa = agents.find((a) => a.agentId === 'qa');
    const integrator = agents.find((a) => a.agentId === 'integrator');

    assert.match(qa?.result ?? '', /did not produce output/);
    assert.match(qa?.result ?? '', /No-go/);
    assert.match(integrator?.result ?? '', /Gaps carried forward/);
    assert.match(integrator?.result ?? '', /Marketing did not run/);
  });

  it('aborts the run instead when continueOnWorkerFailure is off', async () => {
    const h = harness({ continueOnWorkerFailure: false });
    const detail = await h.runToCompletion('Launch an online cookie store in Italy [fail:research]');
    const run = detail.runs[0];
    assert.ok(run);

    assert.equal(run.agents.find((a) => a.agentId === 'research')?.status, 'failed');
    assert.equal(run.agents.filter((a) => a.status === 'skipped').length, 6);
    assert.equal(run.run.status, 'failed');
    assert.equal(detail.mission.finalResult, null);
  });
});

describe('mission pipeline — QA and Integrator failures abort the run', () => {
  it('skips the Integrator when QA fails, and leaves nothing pending', async () => {
    const h = harness();
    const detail = await h.runToCompletion('Launch an online cookie store in Italy [fail:qa]');
    const run = detail.runs[0];
    assert.ok(run);

    assert.equal(run.agents.find((a) => a.agentId === 'qa')?.status, 'failed');
    assert.equal(run.agents.find((a) => a.agentId === 'integrator')?.status, 'skipped');
    assert.equal(run.agents.filter((a) => a.status === 'pending').length, 0, 'no agent may be left pending');
    assert.equal(run.run.status, 'failed');
    assert.equal(detail.mission.status, 'failed');
    assert.equal(detail.mission.finalResult, null);
  });

  it('fails the run when the Integrator itself fails', async () => {
    const h = harness();
    const detail = await h.runToCompletion('Launch an online cookie store in Italy [fail:integrator]');
    const run = detail.runs[0];
    assert.ok(run);

    assert.equal(run.agents.filter((a) => a.status === 'completed').length, 7);
    assert.equal(run.agents.find((a) => a.agentId === 'integrator')?.status, 'failed');
    assert.equal(detail.mission.finalResult, null);
  });
});

describe('re-running a mission', () => {
  it('creates a second run, preserves the first, and keeps both in history', async () => {
    const h = harness();
    const first = await h.runToCompletion('Launch an online cookie store in Italy');
    const missionId = first.mission.id;

    await h.service.run(missionId, {});
    await h.queue.drain();

    const detail = await h.service.get(missionId);
    assert.equal(detail.runs.length, 2);
    assert.deepEqual(
      detail.runs.map((r) => r.run.attempt),
      [2, 1],
      'runs should come back newest first',
    );
    assert.equal(detail.runs[0]?.agents.length, 8);
    assert.equal(detail.runs[1]?.agents.length, 8);
    assert.equal(detail.mission.status, 'completed');
  });

  it('refuses a second concurrent run', async () => {
    const h = harness();
    const created = await h.service.create({ prompt: 'Launch an online cookie store in Italy' });
    await assert.rejects(
      h.service.run(created.mission.mission.id, {}),
      (error: unknown) => error instanceof MissionAlreadyRunningError,
    );
    await h.queue.drain();
  });

  it('rejects a run for a mission that does not exist', async () => {
    const h = harness();
    await assert.rejects(h.service.run('11111111-2222-3333-4444-555555555555', {}), /not found|does not exist/i);
  });
});

describe('autoStart: false', () => {
  it('creates the mission without a run or any queued work', async () => {
    const h = harness();
    const created = await h.service.create({ prompt: 'Launch an online cookie store in Italy', autoStart: false });

    assert.equal(created.run, null);
    assert.equal(created.mission.runs.length, 0);
    assert.equal(h.queue.size(), 0);
    assert.equal(created.mission.mission.status, 'pending');
  });

  it('runs later on demand', async () => {
    const h = harness();
    const created = await h.service.create({ prompt: 'Launch an online cookie store in Italy', autoStart: false });
    await h.service.run(created.mission.mission.id, {});
    await h.queue.drain();

    const detail = await h.service.get(created.mission.mission.id);
    assert.equal(detail.mission.status, 'completed');
  });
});

describe('listing and stats', () => {
  it('summarises missions newest first with agent counts', async () => {
    const h = harness();
    await h.runToCompletion('Launch an online cookie store in Italy');
    await h.runToCompletion('Open a bike repair shop in Lisbon [fail:finance]');

    const { items, total } = await h.service.list({ limit: 10, offset: 0 });
    assert.equal(total, 2);
    assert.equal(items.length, 2);
    assert.match(items[0]?.mission.title ?? '', /bike repair/);
    assert.equal(items[0]?.runCount, 1);
    assert.equal(items[0]?.agentCounts.failed, 1);
    assert.equal(items[0]?.agentCounts.completed, 7);
    assert.equal(items[1]?.agentCounts.completed, 8);
  });

  it('filters by status and paginates', async () => {
    const h = harness();
    await h.runToCompletion('Launch an online cookie store in Italy');
    await h.runToCompletion('Open a bike repair shop in Lisbon [fail:finance]');

    const completed = await h.service.list({ limit: 10, offset: 0, status: 'completed' });
    assert.equal(completed.total, 1);
    assert.match(completed.items[0]?.mission.title ?? '', /cookie/);

    const page = await h.service.list({ limit: 1, offset: 1 });
    assert.equal(page.items.length, 1);
    assert.equal(page.total, 2);
  });

  it('reports dashboard stats', async () => {
    const h = harness();
    await h.runToCompletion('Launch an online cookie store in Italy');
    await h.runToCompletion('Open a bike repair shop in Lisbon [fail:finance]');

    assert.deepEqual(await h.service.stats(), {
      total: 2,
      pending: 0,
      running: 0,
      completed: 1,
      failed: 1,
    });
  });
});

describe('run persistence is atomic', () => {
  it('does not enqueue a run when persisting its agents fails', async () => {
    const repos = createMemoryRepositories();
    const providers = new ProviderRegistry().register(new MockProvider({ sleep: () => Promise.resolve() }), {
      makeDefault: true,
    });
    const queue = new InProcessJobQueue({ logger: silentLogger });
    queue.process(() => Promise.resolve());
    queue.start();

    // Simulate the database rejecting the agent insert mid-transaction.
    const broken: Repositories = {
      ...repos,
      transaction: (fn) =>
        repos.transaction((set) =>
          fn({
            ...set,
            agents: {
              ...set.agents,
              createMany: () => Promise.reject(new Error('connection lost')),
            },
          }),
        ),
    };

    const service = new MissionService({
      repositories: broken,
      providers,
      queue,
      logger: silentLogger,
      clock: fakeClock(),
    });

    await assert.rejects(service.create({ prompt: 'Launch an online cookie store in Italy' }), /connection lost/);

    // The critical assertion: no job was handed to the queue, so no worker can
    // pick up a run whose agents were never written.
    assert.equal(queue.size(), 0);
  });

  it('fails a run with no agent executions instead of reporting it completed', async () => {
    const repos = createMemoryRepositories();
    const providers = new ProviderRegistry().register(new MockProvider({ sleep: () => Promise.resolve() }), {
      makeDefault: true,
    });
    const clock = fakeClock();

    const mission = await repos.missions.create({
      id: 'm1',
      prompt: 'Launch an online cookie store in Italy',
      title: 'Launch an online cookie store in Italy',
      createdAt: clock.now(),
    });
    const run = await repos.runs.create({
      id: 'r1',
      missionId: mission.id,
      attempt: 1,
      providerId: 'mock',
      model: 'mock-1',
      createdAt: clock.now(),
    });

    const orchestrator = new MissionOrchestrator({
      repositories: repos,
      providers,
      logger: silentLogger,
      clock,
    });

    await assert.rejects(orchestrator.execute(run.id), /no agent executions/);

    const after = await repos.runs.findById(run.id);
    assert.equal(after?.status, 'failed', 'an empty run must not be reported as completed');
    assert.equal((await repos.missions.findById(mission.id))?.status, 'failed');
  });
});

describe('crash recovery', () => {
  it('closes runs left in flight by a restart instead of leaving them running forever', async () => {
    const repos = createMemoryRepositories();
    const providers = new ProviderRegistry().register(new MockProvider({ sleep: () => Promise.resolve() }), {
      makeDefault: true,
    });

    // A queue that accepts jobs and never runs them simulates a process that
    // died between enqueue and execution.
    const deadQueue = new InProcessJobQueue({ logger: silentLogger });
    deadQueue.process(() => Promise.resolve());

    const service = new MissionService({
      repositories: repos,
      providers,
      queue: deadQueue,
      logger: silentLogger,
      clock: fakeClock(),
    });

    const created = await service.create({ prompt: 'Launch an online cookie store in Italy' });
    const missionId = created.mission.mission.id;

    const recovered = await recoverUnfinishedRuns({ repositories: repos, logger: silentLogger });
    assert.equal(recovered, 1);

    const detail = await service.get(missionId);
    assert.equal(detail.mission.status, 'failed');
    assert.equal(detail.runs[0]?.run.status, 'failed');
    assert.match(detail.runs[0]?.run.error ?? '', /server restarted/i);
    assert.equal(detail.runs[0]?.agents.filter((a) => a.status === 'pending').length, 0);
  });

  it('does nothing when every run is finished', async () => {
    const h = harness();
    await h.runToCompletion('Launch an online cookie store in Italy');
    assert.equal(await recoverUnfinishedRuns({ repositories: h.repos, logger: silentLogger }), 0);
  });
});
