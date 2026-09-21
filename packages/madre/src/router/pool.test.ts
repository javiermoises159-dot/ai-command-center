/**
 * Pool mode: every real provider takes turns, with no fixed roles, and a provider
 * whose free quota is spent rests for a while and then comes back by itself.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ProviderError } from '@acc/domain';

import { PermissionPolicy } from '../permissions/policy.ts';
import { RulesPlanner } from '../compiler/planner.ts';
import { CostController } from '../cost/controller.ts';
import { diagnose } from '../execution/healing.ts';
import { createAgentRegistry } from '../registry/agents.ts';
import { ProviderCatalog } from '../registry/providers.ts';
import { createToolRegistry } from '../registry/tools.ts';
import { FakeClock, createHarness, createProviderRegistry } from '../testing.ts';
import { SmartRouter } from './router.ts';

const KEY = 'sk-test-FAKEFAKEFAKE1234567890';
const models = (m: string) => ({ apiKey: KEY, models: [m] });

function setup(pool: boolean) {
  const { store } = createHarness();
  const registry = createProviderRegistry({
    mock: { minLatencyMs: 0, maxLatencyMs: 0 },
    openai: models('gpt-test'),
    anthropic: models('claude-test'),
    gemini: models('gemini-test'),
  });
  const agents = createAgentRegistry();
  const tools = createToolRegistry();
  const catalog = new ProviderCatalog(() => registry.describe());
  const router = new SmartRouter(agents, catalog, tools, new PermissionPolicy(), new CostController(store), { clock: new FakeClock(), poolMode: pool });
  catalog.attachCircuit((id) => router.circuitState(id));
  const plan = new RulesPlanner(agents, tools).plan('Quiero lanzar una tienda online de cookies en Italia.');
  return { router, catalog, steps: plan.steps.filter((s) => s.kind === 'agent') };
}

describe('pool mode routing', () => {
  it('uses every real provider across the steps, and never the simulation while real ones are healthy', async () => {
    const { router, steps } = setup(true);
    const used = new Map<string, number>();
    for (let round = 0; round < 3; round += 1) {
      for (const step of steps) {
        const d = await router.route(step, { missionId: 'm1' });
        const id = d.provider?.id ?? 'none';
        used.set(id, (used.get(id) ?? 0) + 1);
      }
    }
    assert.deepEqual([...used.keys()].sort(), ['anthropic', 'gemini', 'openai']);
    const counts = [...used.values()];
    assert.ok(Math.max(...counts) - Math.min(...counts) <= 1, `evenly shared, got ${JSON.stringify([...used])}`);
  });

  it('without pool mode the same provider keeps the work (the old behaviour)', async () => {
    const { router, steps } = setup(false);
    const used = new Set<string>();
    for (const step of steps) used.add((await router.route(step, { missionId: 'm1' })).provider?.id ?? 'none');
    assert.equal(used.size, 1);
  });

  it('skips a provider the step should avoid, and says it works as a pool', async () => {
    const { router, steps } = setup(true);
    for (let i = 0; i < 6; i += 1) {
      const d = await router.route(steps[0]!, { missionId: 'm1', avoidProviders: ['gemini', 'openai'] });
      assert.equal(d.provider?.id, 'anthropic');
    }
    const d = await router.route(steps[0]!, { missionId: 'm1' });
    assert.ok(d.rationale.some((r) => /Modo conjunto/.test(r)));
  });
});

describe('resting a provider whose quota is spent', () => {
  it('takes it out of rotation and brings it back by itself', async () => {
    const { router, steps } = setup(true);
    router.restProvider('gemini', 'cupo agotado', 40);
    for (let i = 0; i < 6; i += 1) {
      assert.notEqual((await router.route(steps[0]!, { missionId: 'm1' })).provider?.id, 'gemini');
    }
    await new Promise((r) => setTimeout(r, 80));
    const back = new Set<string>();
    for (let i = 0; i < 6; i += 1) back.add((await router.route(steps[0]!, { missionId: 'm1' })).provider?.id ?? 'none');
    assert.ok(back.has('gemini'));
  });
});

describe('healing in pool mode', () => {
  const rate = new ProviderError('PROVIDER_RATE_LIMITED', { detail: 'demasiadas peticiones', provider: 'gemini' });
  const quota = new ProviderError('PROVIDER_QUOTA_EXHAUSTED', { detail: 'cupo agotado', provider: 'groq' });

  it('switches provider at once on a rate limit or a timeout instead of retrying the same one', () => {
    const base = { baseBackoffMs: 500, maxBackoffMs: 8000 };
    assert.equal(diagnose(rate, 1, base).switchProvider, false);
    const pooled = diagnose(rate, 1, { ...base, poolSwitch: true });
    assert.equal(pooled.switchProvider, true);
    assert.equal(pooled.retryable, true);
    assert.ok(pooled.backoffMs <= 300);
    assert.equal(diagnose(new Error('fetch failed'), 1, { ...base, poolSwitch: true }).switchProvider, true);
    assert.equal(diagnose(quota, 1, { ...base, poolSwitch: true }).switchProvider, true);
  });

  it('still fails a request that no other provider would accept', () => {
    const bad = new ProviderError('PROVIDER_BAD_REQUEST', { detail: 'contexto demasiado largo', provider: 'gemini' });
    const d = diagnose(bad, 1, { baseBackoffMs: 500, maxBackoffMs: 8000, poolSwitch: true });
    assert.equal(d.retryable, false);
    assert.equal(d.action, 'fail');
  });
});
