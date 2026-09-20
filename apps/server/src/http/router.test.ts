/**
 * API-level tests.
 *
 * These exercise the real router against the real service, queue, orchestrator
 * and mock provider. Only the transport is bypassed — the Express adapter is a
 * ~40-line translation of these same request and response objects.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { silentLogger } from '@acc/domain';
import { InProcessJobQueue, MissionOrchestrator, MissionService } from '@acc/orchestrator';
import { MockProvider, ProviderRegistry } from '@acc/providers';
import { createMemoryRepositories } from '@acc/repositories/memory';

import { createRouter, type Router } from './router.ts';
import { matchPath, type HttpMethod, type HttpRequest } from './types.ts';

interface Ctx {
  router: Router;
  queue: InProcessJobQueue;
  request(method: HttpMethod, path: string, options?: { body?: unknown; query?: Record<string, string> }): Promise<{
    status: number;
    body: any;
  }>;
}

function context(): Ctx {
  const repos = createMemoryRepositories();
  const providers = new ProviderRegistry()
    .register(new MockProvider({ sleep: () => Promise.resolve() }), { makeDefault: true });
  const queue = new InProcessJobQueue({ logger: silentLogger });

  const orchestrator = new MissionOrchestrator({
    repositories: repos,
    providers,
    logger: silentLogger,
    options: { agentTimeoutMs: 5_000 },
  });
  queue.process(async (job) => {
    await orchestrator.execute(job.runId);
  });
  queue.start();

  const missions = new MissionService({ repositories: repos, providers, queue, logger: silentLogger });
  const router = createRouter({ missions, providers, logger: silentLogger, version: 'test' });

  return {
    router,
    queue,
    async request(method, path, options = {}) {
      const request: HttpRequest = {
        method,
        path,
        query: options.query ?? {},
        body: options.body,
        headers: {},
      };
      const response = await router.handle(request);
      return { status: response.status, body: response.body as any };
    },
  };
}

describe('matchPath', () => {
  it('matches exact paths and captures parameters', () => {
    assert.deepEqual(matchPath('/api/missions', '/api/missions'), {});
    assert.deepEqual(matchPath('/api/missions/:id', '/api/missions/abc'), { id: 'abc' });
    assert.deepEqual(matchPath('/api/missions/:id/run', '/api/missions/abc/run'), { id: 'abc' });
  });

  it('rejects mismatches rather than matching loosely', () => {
    assert.equal(matchPath('/api/missions', '/api/missions/abc'), null);
    assert.equal(matchPath('/api/missions/:id', '/api/missions'), null);
    assert.equal(matchPath('/api/missions/:id', '/api/other/abc'), null);
  });

  it('url-decodes parameters and survives a malformed escape', () => {
    assert.deepEqual(matchPath('/api/missions/:id', '/api/missions/a%20b'), { id: 'a b' });
    assert.equal(matchPath('/api/missions/:id', '/api/missions/%E0%A4%A'), null);
  });
});

describe('GET /api/health', () => {
  it('reports ok with the active provider', async () => {
    const { status, body } = await context().request('GET', '/api/health');
    assert.equal(status, 200);
    assert.equal(body.status, 'ok');
    assert.equal(body.provider, 'mock');
  });
});

describe('GET /api/agents', () => {
  it('returns the eight-agent catalog in order', async () => {
    const { status, body } = await context().request('GET', '/api/agents');
    assert.equal(status, 200);
    assert.equal(body.items.length, 8);
    assert.equal(body.items[0].id, 'strategy');
    assert.equal(body.items[7].id, 'integrator');
    assert.ok(body.items[0].role.length > 0);
  });
});

describe('GET /api/providers', () => {
  it('lists the mock as available and nothing else as usable', async () => {
    const { status, body } = await context().request('GET', '/api/providers');
    assert.equal(status, 200);
    assert.equal(body.defaultProviderId, 'mock');
    assert.equal(body.items.length, 1);
    assert.equal(body.items[0].availability, 'available');
  });
});

describe('POST /api/missions', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = context();
  });

  it('returns 202 with the full pipeline before any agent has finished', async () => {
    const { status, body } = await ctx.request('POST', '/api/missions', {
      body: { prompt: 'Launch an online cookie store in Italy' },
    });

    assert.equal(status, 202);
    assert.equal(body.mission.status, 'pending');
    assert.equal(body.mission.finalResult, null);
    assert.equal(body.run.attempt, 1);
    assert.equal(body.mission.runs.length, 1);
    assert.equal(body.mission.runs[0].agents.length, 8);
    assert.ok(body.mission.runs[0].progress < 1);

    await ctx.queue.drain();
  });

  it('returns 201 and queues nothing when autoStart is false', async () => {
    const { status, body } = await ctx.request('POST', '/api/missions', {
      body: { prompt: 'Launch an online cookie store in Italy', autoStart: false },
    });
    assert.equal(status, 201);
    assert.equal(body.run, null);
    assert.equal(body.mission.runs.length, 0);
    assert.equal(ctx.queue.size(), 0);
  });

  it('rejects an invalid prompt with 400 and field-level issues', async () => {
    const { status, body } = await ctx.request('POST', '/api/missions', { body: { prompt: 'no' } });
    assert.equal(status, 400);
    assert.equal(body.error.code, 'validation_error');
    assert.equal(body.error.issues[0].path, 'prompt');
  });

  it('rejects a missing body with 400 rather than crashing', async () => {
    const { status, body } = await ctx.request('POST', '/api/missions');
    assert.equal(status, 400);
    assert.equal(body.error.code, 'validation_error');
  });

  it('rejects an unknown provider with 400 and creates no mission', async () => {
    const rejected = await ctx.request('POST', '/api/missions', {
      body: { prompt: 'Launch an online cookie store in Italy', providerId: 'nope' },
    });
    assert.equal(rejected.status, 400);

    const list = await ctx.request('GET', '/api/missions');
    assert.equal(list.body.total, 0, 'a rejected provider must not leave a mission behind');
  });

  it('rejects a real provider that has no key or model, with 503, and does not fall back to the mock', async () => {
    const providers = new ProviderRegistry()
      .register(new MockProvider({ sleep: () => Promise.resolve() }), { makeDefault: true });
    const { OpenAIProvider } = await import('@acc/providers');
    providers.register(new OpenAIProvider());

    const repos = createMemoryRepositories();
    const queue = new InProcessJobQueue({ logger: silentLogger });
    queue.process(() => Promise.resolve());
    queue.start();
    const missions = new MissionService({ repositories: repos, providers, queue, logger: silentLogger });
    const router = createRouter({ missions, providers, logger: silentLogger, version: 'test' });

    const response = await router.handle({
      method: 'POST',
      path: '/api/missions',
      query: {},
      headers: {},
      body: { prompt: 'Launch an online cookie store in Italy', providerId: 'openai' },
    });

    assert.equal(response.status, 503);
    const message = (response.body as any).error.message as string;
    assert.match(message, /OPENAI_API_KEY/);
    assert.match(message, /OPENAI_MODEL/);
    assert.match(message, /nunca se sustituye por una simulación/i);
  });
});

describe('GET /api/missions/:id', () => {
  it('returns the finished mission with results per agent', async () => {
    const ctx = context();
    const created = await ctx.request('POST', '/api/missions', {
      body: { prompt: 'Launch an online cookie store in Italy' },
    });
    await ctx.queue.drain();

    const { status, body } = await ctx.request('GET', `/api/missions/${created.body.mission.id}`);
    assert.equal(status, 200);
    assert.equal(body.status, 'completed');
    assert.ok(body.finalResult.length > 0);
    assert.equal(body.runs[0].progress, 1);
    assert.equal(body.runs[0].agents.filter((a: any) => a.status === 'completed').length, 8);

    const strategy = body.runs[0].agents.find((a: any) => a.agentId === 'strategy');
    assert.ok(strategy.result.length > 0);
    assert.equal(strategy.usage.provider, 'mock');
    assert.ok(strategy.durationMs !== null);
    assert.equal(typeof strategy.startedAt, 'string');
  });

  it('404s for an unknown id', async () => {
    const { status, body } = await context().request('GET', '/api/missions/does-not-exist');
    assert.equal(status, 404);
    assert.equal(body.error.code, 'mission_not_found');
  });

  it('surfaces a failed agent with its error', async () => {
    const ctx = context();
    const created = await ctx.request('POST', '/api/missions', {
      body: { prompt: 'Launch an online cookie store in Italy [fail:marketing]' },
    });
    await ctx.queue.drain();

    const { body } = await ctx.request('GET', `/api/missions/${created.body.mission.id}`);
    assert.equal(body.status, 'failed');
    const marketing = body.runs[0].agents.find((a: any) => a.agentId === 'marketing');
    assert.equal(marketing.status, 'failed');
    assert.match(marketing.error, /Fallo simulado/);
    assert.ok(body.finalResult, 'the partial brief is still delivered');
  });
});

describe('POST /api/missions/:id/run', () => {
  it('queues a second run and returns 202 immediately', async () => {
    const ctx = context();
    const created = await ctx.request('POST', '/api/missions', {
      body: { prompt: 'Launch an online cookie store in Italy' },
    });
    await ctx.queue.drain();

    const { status, body } = await ctx.request('POST', `/api/missions/${created.body.mission.id}/run`);
    assert.equal(status, 202);
    assert.equal(body.run.attempt, 2);
    assert.equal(body.run.status, 'pending');

    await ctx.queue.drain();
    const detail = await ctx.request('GET', `/api/missions/${created.body.mission.id}`);
    assert.equal(detail.body.runs.length, 2);
    assert.equal(detail.body.runs[0].attempt, 2);
  });

  it('409s while a run is already in flight', async () => {
    const ctx = context();
    const created = await ctx.request('POST', '/api/missions', {
      body: { prompt: 'Launch an online cookie store in Italy' },
    });

    const { status, body } = await ctx.request('POST', `/api/missions/${created.body.mission.id}/run`);
    assert.equal(status, 409);
    assert.equal(body.error.code, 'mission_already_running');

    await ctx.queue.drain();
  });

  it('404s for an unknown mission', async () => {
    const { status } = await context().request('POST', '/api/missions/nope/run');
    assert.equal(status, 404);
  });
});

describe('GET /api/missions', () => {
  it('paginates, filters and echoes the window', async () => {
    const ctx = context();
    for (const prompt of [
      'Launch an online cookie store in Italy',
      'Open a bike repair shop in Lisbon',
      'Start a coffee subscription in Berlin [fail:finance]',
    ]) {
      await ctx.request('POST', '/api/missions', { body: { prompt } });
      await ctx.queue.drain();
    }

    const all = await ctx.request('GET', '/api/missions');
    assert.equal(all.body.total, 3);
    assert.equal(all.body.limit, 20);
    assert.match(all.body.items[0].title, /coffee subscription/);
    assert.equal(all.body.items[0].agentCounts.failed, 1);

    const page = await ctx.request('GET', '/api/missions', { query: { limit: '2', offset: '1' } });
    assert.equal(page.body.items.length, 2);

    const failed = await ctx.request('GET', '/api/missions', { query: { status: 'failed' } });
    assert.equal(failed.body.total, 1);

    const bad = await ctx.request('GET', '/api/missions', { query: { status: 'exploded' } });
    assert.equal(bad.status, 400);
  });
});

describe('GET /api/stats', () => {
  it('counts missions by status', async () => {
    const ctx = context();
    await ctx.request('POST', '/api/missions', { body: { prompt: 'Launch an online cookie store in Italy' } });
    await ctx.queue.drain();

    const { status, body } = await ctx.request('GET', '/api/stats');
    assert.equal(status, 200);
    assert.deepEqual(body, { total: 1, pending: 0, running: 0, completed: 1, failed: 0 });
  });
});

describe('routing errors', () => {
  it('404s an unknown path', async () => {
    const { status, body } = await context().request('GET', '/api/nope');
    assert.equal(status, 404);
    assert.equal(body.error.code, 'not_found');
  });

  it('405s a known path with the wrong method', async () => {
    const { status, body } = await context().request('DELETE', '/api/missions');
    assert.equal(status, 405);
    assert.equal(body.error.code, 'method_not_allowed');
  });

  it('never leaks a stack trace in an error body', async () => {
    const { body } = await context().request('GET', '/api/missions/does-not-exist');
    assert.deepEqual(Object.keys(body.error).sort(), ['code', 'issues', 'message']);
    assert.ok(!JSON.stringify(body).includes('at Object.'));
  });
});
