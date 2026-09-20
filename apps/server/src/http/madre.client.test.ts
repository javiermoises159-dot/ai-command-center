/**
 * The typed client against the real router: every MADRE response the server
 * produces must satisfy the schema the client parses it with.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createApiClient } from '@acc/contracts/client';
import { silentLogger } from '@acc/domain';
import { createMadre } from '@acc/madre';
import { InProcessJobQueue, MissionService } from '@acc/orchestrator';
import { createProviderRegistry } from '@acc/providers';
import { createMemoryRepositories } from '@acc/repositories/memory';

import { createRouter } from './router.ts';

function clientOverRouter() {
  const repositories = createMemoryRepositories();
  const providers = createProviderRegistry({ mock: { minLatencyMs: 0, maxLatencyMs: 0 } });
  const queue = new InProcessJobQueue({ logger: silentLogger });
  const madre = createMadre({ repositories, providers, enqueue: (j) => queue.enqueue(j), sleep: () => Promise.resolve() });
  queue.process(async (job) => { await madre.execute({ runId: job.runId, ...(job.resume === true ? { resume: true } : {}) }); });
  queue.start();
  const missions = new MissionService({ repositories, providers, queue, logger: silentLogger, defaultMode: 'madre' });
  const router = createRouter({ missions, providers, madre: madre.service, logger: silentLogger, version: 't' });

  const fetch = (async (url: string, init?: RequestInit) => {
    const u = new URL(url, 'http://x');
    const query: Record<string, string> = {};
    u.searchParams.forEach((v, k) => { query[k] = v; });
    const r = await router.handle({ method: (init?.method ?? 'GET') as never, path: u.pathname, query, body: init?.body ? JSON.parse(String(init.body)) : undefined, headers: {} });
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;

  return { client: createApiClient({ baseUrl: '', fetch }), queue };
}

describe('typed client ↔ MADRE server', () => {
  it('parses every MADRE response the server produces', async () => {
    const { client, queue } = clientOverRouter();

    assert.ok((await client.madreAgents()).items.length >= 8);
    assert.ok((await client.madreProviders()).items.some((p) => p.id === 'mock'));
    assert.ok((await client.madreTools()).items.length > 10);
    assert.equal((await client.madrePermissions()).modes.FINANCIAL, 'BLOCK');
    assert.ok((await client.madreCompile('Quiero lanzar una tienda online de cookies en Italia.')).plan.steps.length >= 8);

    const created = await client.createMission({ prompt: 'Quiero lanzar una tienda online de cookies en Italia.' });
    await queue.drain();
    const snap = await client.missionMadre(created.mission.id);
    assert.equal(snap.state?.phase, 'completed');

    const overview = await client.madreOverview();
    assert.ok(overview.world.missions.total >= 1);
    assert.ok((await client.madreActivity(20)).items.length > 0);
    assert.equal((await client.madreApprovals()).items.length, 0);

    const remembered = await client.madreRemember({ title: 'Nota', content: 'Prefiero respuestas breves.', type: 'preference' });
    assert.equal(remembered.entry.verified, false);
    assert.ok((await client.madreMemory({ q: 'breves' })).items.length >= 1);
    assert.equal((await client.madreForget(remembered.entry.id)).deleted, true);

    const budget = await client.madreSetBudget({ dailyUsd: 3, onExceed: 'ask' });
    assert.equal(budget.budget.dailyUsd, 3);
    assert.ok((await client.madreBudget()).cost);
    assert.equal((await client.cancelMission(created.mission.id)).cancelled, false);
  });

  it('carries the server’s error code for a missing approval', async () => {
    const { client } = clientOverRouter();
    await assert.rejects(() => client.decideApproval('nope', 'approve'), (e: any) => e.status === 404 && e.code === 'not_found');
  });
});
