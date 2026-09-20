/**
 * MADRE end to end through the API: router → MissionService → queue → MADRE
 * engine → repositories, with the simulated provider and in-memory storage.
 * Only the transport is bypassed.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { silentLogger } from '@acc/domain';
import { createMadre } from '@acc/madre';
import { InProcessJobQueue, MissionService, recoverUnfinishedRuns } from '@acc/orchestrator';
import { createProviderRegistry } from '@acc/providers';
import { createMemoryRepositories } from '@acc/repositories/memory';

import { createRouter } from './router.ts';
import type { HttpMethod } from './types.ts';

function setup(options: { defaultMode?: 'classic' | 'madre'; ollama?: Parameters<typeof createProviderRegistry>[0] } = {}) {
  const repositories = createMemoryRepositories();
  const providers = createProviderRegistry({ mock: { minLatencyMs: 0, maxLatencyMs: 0 }, ...(options.ollama ?? {}) });
  const queue = new InProcessJobQueue({ logger: silentLogger });
  const madre = createMadre({ repositories, providers, enqueue: (job) => queue.enqueue(job), engine: { agentTimeoutMs: 5_000 }, sleep: () => Promise.resolve() });
  // Same wiring as the composition root: both modes run on the MADRE engine.
  queue.process(async (job) => {
    await madre.execute({ runId: job.runId, mode: job.mode === 'madre' ? 'madre' : 'classic', ...(job.resume === true ? { resume: true } : {}) });
  });
  queue.start();
  const missions = new MissionService({ repositories, providers, queue, logger: silentLogger, defaultMode: options.defaultMode ?? 'madre' });
  const router = createRouter({ missions, providers, madre: madre.service, logger: silentLogger, version: 'test' });
  return {
    repositories, queue, madre, missions,
    async call(method: HttpMethod, path: string, body?: unknown, query: Record<string, string> = {}) {
      const r = await router.handle({ method, path, query, body, headers: {} });
      return { status: r.status, body: r.body as any };
    },
  };
}

describe('MADRE through the API', () => {
  it('runs a mission through compile, plan, route, execute, QA and integration', async () => {
    const s = setup();
    const created = await s.call('POST', '/api/missions', { prompt: 'Quiero lanzar una tienda online de cookies en Italia.' });
    assert.equal(created.status, 202, 'the request returns before the agents finish');
    const missionId = created.body.mission.id as string;

    await s.queue.drain();

    const detail = await s.call('GET', `/api/missions/${missionId}`);
    assert.equal(detail.body.status, 'completed');
    const legacy = detail.body.runs[0];
    assert.equal(legacy.status, 'completed');
    assert.ok(legacy.agents.length >= 8);
    assert.ok(typeof legacy.finalResult === 'string' && legacy.finalResult.length > 100);

    const snap = (await s.call('GET', `/api/missions/${missionId}/madre`)).body;
    assert.equal(snap.state.phase, 'completed');
    assert.ok(snap.plan.steps.length >= 8);
    assert.ok(snap.state.steps.every((st: any) => ['DONE', 'CANCELLED'].includes(st.status) || st.status === 'BLOCKED'));
    assert.ok(snap.audit.some((e: any) => e.type === 'plan.created'));
    assert.ok(snap.state.qaRounds.length >= 1);
    assert.match(legacy.finalResult, /[Ss]imulad/, 'una ejecución simulada tiene que decirlo');
  });

  it('keeps the classic pipeline available, and runs it on the same engine as everything else', async () => {
    const s = setup({ defaultMode: 'madre' });
    const created = await s.call('POST', '/api/missions', { prompt: 'Launch an online cookie store in Italy', mode: 'classic' });
    await s.queue.drain();
    const id = created.body.mission.id as string;
    const detail = await s.call('GET', `/api/missions/${id}`);
    assert.equal(detail.body.status, 'completed');
    assert.equal(detail.body.runs[0].agents.length, 8);
    assert.deepEqual(detail.body.runs[0].agents.map((a: any) => a.agentId), ['strategy', 'research', 'code', 'design', 'marketing', 'finance', 'qa', 'integrator']);
    assert.ok(detail.body.runs[0].agents.every((a: any) => a.status === 'completed'));

    // What used to be missing: MADRE state, routing, audit and a trace.
    const snap = (await s.call('GET', `/api/missions/${id}/madre`)).body;
    assert.notEqual(snap.runId, null, 'a classic run now has MADRE state');
    assert.equal(snap.state.mode, 'classic');
    assert.equal(snap.plan.planner, 'classic-planner@1');
    assert.equal(snap.audit.filter((e: any) => e.type === 'route.decided').length, 8);
    const trace = (await s.call('GET', `/api/missions/${id}/trace`)).body.trace;
    assert.equal(trace.mode, 'classic');
    assert.equal(trace.steps.length, 8);
    assert.ok(trace.steps.every((st: any) => st.provider === 'mock' && st.status === 'DONE'));
  });

  it('cancels a classic mission while it runs, and one that is still queued', async () => {
    // Slow the simulated provider so there is something to cancel.
    const repositories = createMemoryRepositories();
    const providers = createProviderRegistry({ mock: { minLatencyMs: 150, maxLatencyMs: 150 } });
    const queue = new InProcessJobQueue({ logger: silentLogger });
    const madre = createMadre({ repositories, providers, enqueue: (job) => queue.enqueue(job), engine: { agentTimeoutMs: 5_000 }, sleep: () => Promise.resolve() });
    queue.process(async (job) => {
      await madre.execute({ runId: job.runId, mode: job.mode === 'madre' ? 'madre' : 'classic' });
    });
    queue.start();
    const missions = new MissionService({ repositories, providers, queue, logger: silentLogger, defaultMode: 'classic' });
    const router = createRouter({ missions, providers, madre: madre.service, logger: silentLogger, version: 'test' });
    const call = async (method: HttpMethod, path: string, body?: unknown) => {
      const r = await router.handle({ method, path, query: {}, body, headers: {} });
      return { status: r.status, body: r.body as any };
    };

    const created = await call('POST', '/api/missions', { prompt: 'Launch an online cookie store in Italy', mode: 'classic' });
    const id = created.body.mission.id as string;
    await new Promise((r) => setTimeout(r, 250)); // a couple of agents in
    const cancelled = await call('POST', `/api/missions/${id}/cancel`);
    assert.deepEqual(cancelled.body, { cancelled: true }, 'cancelling a classic mission used to answer false');
    await queue.drain();

    const detail = (await call('GET', `/api/missions/${id}`)).body;
    assert.equal(detail.status, 'failed');
    assert.ok(detail.runs[0].agents.every((a: any) => a.status !== 'running' && a.status !== 'pending'));
    const snap = (await call('GET', `/api/missions/${id}/madre`)).body;
    assert.equal(snap.state.phase, 'cancelled');
    assert.equal(snap.state.steps.filter((st: any) => st.status === 'RUNNING').length, 0);
    assert.equal((await call('POST', `/api/missions/${id}/cancel`)).body.cancelled, false, 'nothing left to cancel');
    assert.deepEqual(await madre.service.cancel(id), false);
  });

  it('after a restart mid-run, the API tells one consistent story: mission, run, agents, steps and trace', async () => {
    const repositories = createMemoryRepositories();
    const providers = createProviderRegistry({ mock: { minLatencyMs: 0, maxLatencyMs: 0 } });
    const queue = new InProcessJobQueue({ logger: silentLogger });
    // The process that will die: after two answers its model never replies again.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let answered = 0;
    const hanging = {
      async run(input: any) {
        answered += 1;
        if (answered > 2) await gate;
        return { text: `## ${input.step.title}\n\nResultado simulado de prueba.`, provider: 'mock', model: 'mock-1', requestId: `r-${answered}`, promptTokens: 1, completionTokens: 1, latencyMs: 1, source: 'mock' as const, simulated: true };
      },
    };
    const dying = createMadre({ repositories, providers, enqueue: (job) => queue.enqueue(job), runner: hanging, engine: { agentTimeoutMs: 60_000 }, sleep: () => Promise.resolve() });
    queue.process(async (job) => {
      await dying.execute({ runId: job.runId, mode: 'madre' });
    });
    queue.start();
    const missions = new MissionService({ repositories, providers, queue, logger: silentLogger, defaultMode: 'madre' });
    const created = await missions.create({ prompt: 'Quiero lanzar una tienda online de cookies en Italia.' });
    const id = created.mission.mission.id;
    for (let i = 0; i < 400; i++) {
      const snap = await dying.service.snapshot(id);
      if ((snap.state?.steps.filter((st) => st.status === 'RUNNING').length ?? 0) >= 2) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.ok(((await dying.service.snapshot(id)).state?.steps.filter((st) => st.status === 'RUNNING').length ?? 0) >= 2, 'the run was really mid-flight');

    // The restart: a new process over the same database, the old one gone.
    const reborn = createMadre({ repositories, providers, enqueue: () => Promise.resolve(), engine: { agentTimeoutMs: 5_000 }, sleep: () => Promise.resolve() });
    const report = await reborn.recover();
    assert.equal(report.recovered.length, 1);
    const router = createRouter({ missions, providers, madre: reborn.service, logger: silentLogger, version: 'test' });
    const call = async (method: HttpMethod, path: string) => (await router.handle({ method, path, query: {}, body: undefined, headers: {} })).body as any;

    const detail = await call('GET', `/api/missions/${id}`);
    const snap = await call('GET', `/api/missions/${id}/madre`);
    const { trace } = await call('GET', `/api/missions/${id}/trace`);

    assert.equal(detail.status, 'failed');
    assert.equal(detail.runs[0].status, 'failed');
    assert.ok(detail.runs[0].agents.every((a: any) => a.status !== 'running' && a.status !== 'pending'));
    assert.equal(snap.state.phase, 'failed');
    assert.equal(snap.state.steps.filter((st: any) => ['RUNNING', 'RETRYING', 'QUEUED', 'WAITING'].includes(st.status)).length, 0);
    assert.equal(trace.recovery.outcome, 'interrupted');
    assert.equal(trace.recovery.retryable, true);
    assert.ok(trace.steps.some((st: any) => st.status === 'FAILED' && /reinició/.test(st.error ?? '')));
    assert.ok(snap.audit.some((e: any) => e.type === 'run.recovered'));
    assert.deepEqual(await reborn.inspect(id), []);

    // A second boot changes nothing.
    assert.equal((await reborn.recover()).recovered.length, 0);
    release();
    await queue.drain();
  });

  it('pauses for the user’s documents, then finishes after they are supplied', async () => {
    const s = setup();
    const created = await s.call('POST', '/api/missions', { prompt: 'Analiza estos documentos y dime las acciones prioritarias.' });
    const missionId = created.body.mission.id as string;
    await s.queue.drain();

    let detail = await s.call('GET', `/api/missions/${missionId}`);
    assert.equal(detail.body.status, 'running', 'a paused run is still open');
    const pending = (await s.call('GET', '/api/madre/approvals')).body.items;
    assert.equal(pending.length, 1);
    assert.equal(pending[0].kind, 'input');

    const decided = await s.call('POST', `/api/madre/approvals/${pending[0].id}/approve`, { note: 'CONTRATO: el proveedor entregará en 30 días. Penalización del 2% por retraso.' });
    assert.equal(decided.status, 200);
    await s.queue.drain();

    detail = await s.call('GET', `/api/missions/${missionId}`);
    assert.equal(detail.body.status, 'completed');
    assert.equal((await s.call('GET', '/api/madre/approvals')).body.items.length, 0);

    const again = await s.call('POST', `/api/madre/approvals/${pending[0].id}/approve`, {});
    assert.equal(again.status, 409);
    assert.equal((await s.call('POST', '/api/madre/approvals/nope/deny', {})).status, 404);
  });

  it('cancels a paused mission', async () => {
    const s = setup();
    const created = await s.call('POST', '/api/missions', { prompt: 'Analiza estos documentos y dime las acciones prioritarias.' });
    await s.queue.drain();
    const id = created.body.mission.id as string;
    const cancelled = await s.call('POST', `/api/missions/${id}/cancel`);
    assert.deepEqual(cancelled.body, { cancelled: true });
    const snap = (await s.call('GET', `/api/missions/${id}/madre`)).body;
    assert.equal(snap.state.phase, 'cancelled');
    assert.equal((await s.call('GET', '/api/madre/approvals')).body.items.length, 0);
    assert.equal((await s.call('POST', `/api/missions/${id}/cancel`)).body.cancelled, false);
  });

  it('recovery closes ordinary orphans but keeps a paused MADRE run', async () => {
    const s = setup();
    const created = await s.call('POST', '/api/missions', { prompt: 'Analiza estos documentos y dime las acciones prioritarias.' });
    await s.queue.drain();
    const closed = await recoverUnfinishedRuns({ repositories: s.repositories, logger: silentLogger, keepRun: (id) => s.madre.isPaused(id) });
    assert.equal(closed, 0);
    assert.equal((await s.call('GET', `/api/missions/${created.body.mission.id}`)).body.status, 'running');
    const closedWithout = await recoverUnfinishedRuns({ repositories: s.repositories, logger: silentLogger });
    assert.equal(closedWithout, 1);
  });

  it('exposes real registries with honest statuses', async () => {
    const s = setup();
    const agents = (await s.call('GET', '/api/madre/agents')).body.items;
    assert.ok(agents.some((a: any) => a.id === 'strategy' && a.status === 'active'));
    assert.ok(agents.some((a: any) => a.id === 'trading_research' && a.status !== 'active'));

    const tools = (await s.call('GET', '/api/madre/tools')).body.items;
    assert.equal(tools.find((t: any) => t.id === 'web.search').status, 'NOT_CONNECTED');
    assert.equal(tools.find((t: any) => t.id === 'distribution.tiktok').status, 'NOT_CONNECTED');

    const providers = (await s.call('GET', '/api/madre/providers')).body.items;
    assert.equal(providers.find((p: any) => p.id === 'mock').status, 'MOCK');
    assert.equal(providers.find((p: any) => p.id === 'ollama').status, 'NOT_CONNECTED');
    // Implemented but without a key: UNCONFIGURED, which is not the same as a stub
    // and never healthy or simulated.
    const openai = providers.find((p: any) => p.id === 'openai');
    assert.equal(openai.status, 'UNCONFIGURED');
    assert.equal(openai.configured, false);
    assert.equal(openai.available, false);
    assert.equal(openai.executable, false);
    assert.equal(openai.healthy, null);
    assert.equal(openai.source, 'real');
    assert.equal(providers.find((p: any) => p.id === 'openai-compatible').status, 'NOT_CONNECTED');

    const permissions = (await s.call('GET', '/api/madre/permissions')).body.modes;
    assert.equal(permissions.FINANCIAL, 'BLOCK');
    assert.notEqual(permissions.PUBLISH, 'AUTO');

    const overview = (await s.call('GET', '/api/madre/overview')).body;
    assert.ok(overview.world.gaps.length > 0);
    assert.equal(overview.pipelines.content.stages.find((x: any) => x.id === 'publish').status, 'blocked');
  });

  it('compiles a mission without running it', async () => {
    const s = setup();
    const before = (await s.call('GET', '/api/stats')).body.total;
    const r = await s.call('POST', '/api/madre/compile', { prompt: 'Quiero lanzar una tienda online de cookies en Italia.' });
    assert.equal(r.status, 200);
    assert.ok(r.body.plan.steps.length >= 8);
    assert.equal(r.body.routing.length, r.body.plan.steps.length);
    assert.equal((await s.call('GET', '/api/stats')).body.total, before);
    assert.equal((await s.call('POST', '/api/madre/compile', {})).status, 400);
  });

  it('stores user memory without treating it as verified, and forgets on request', async () => {
    const s = setup();
    const created = await s.call('POST', '/api/madre/memory', { title: 'Mercado', content: 'Vendo galletas en Milán.', type: 'user_context' });
    assert.equal(created.status, 201);
    assert.equal(created.body.entry.verified, false);
    const list = await s.call('GET', '/api/madre/memory', undefined, { q: 'galletas' });
    assert.equal(list.body.items.length, 1);
    assert.equal((await s.call('DELETE', `/api/madre/memory/${created.body.entry.id}`)).status, 200);
    assert.equal((await s.call('DELETE', `/api/madre/memory/${created.body.entry.id}`)).status, 404);
    assert.equal((await s.call('POST', '/api/madre/memory', { title: '', content: 'x' })).status, 400);
    assert.equal((await s.call('GET', '/api/madre/memory', undefined, { type: 'bogus' })).status, 400);
  });

  it('reads and updates the budget, rejecting bad values', async () => {
    const s = setup();
    assert.equal((await s.call('GET', '/api/madre/budget')).body.budget.dailyUsd, null);
    const r = await s.call('PATCH', '/api/madre/budget', { dailyUsd: 2, onExceed: 'ask' });
    assert.equal(r.body.budget.dailyUsd, 2);
    assert.equal(r.body.budget.onExceed, 'ask');
    assert.equal((await s.call('PATCH', '/api/madre/budget', { dailyUsd: -1 })).status, 400);
    assert.equal((await s.call('PATCH', '/api/madre/budget', { onExceed: 'yolo' })).status, 400);
  });

  it('has no MADRE routes when the core is not provided', async () => {
    const repositories = createMemoryRepositories();
    const providers = createProviderRegistry();
    const queue = new InProcessJobQueue({ logger: silentLogger });
    const missions = new MissionService({ repositories, providers, queue, logger: silentLogger });
    const router = createRouter({ missions, providers, logger: silentLogger, version: 't' });
    const r = await router.handle({ method: 'GET', path: '/api/madre/overview', query: {}, body: undefined, headers: {} });
    assert.equal(r.status, 404);
  });
});
