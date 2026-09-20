/**
 * The Smart Router over the real provider adapters.
 *
 * The adapters are the real classes (OpenAI, Anthropic, Gemini) built with
 * fake credentials; nothing calls a network. What is proven: who the router
 * picks, who it refuses and why (with a structured explanation), that it
 * respects cost and capability, that ties are broken the same way every time,
 * and that a real provider that is configured but failing is never quietly
 * replaced by the simulation.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PermissionPolicy } from '../permissions/policy.ts';
import { RulesPlanner } from '../compiler/planner.ts';
import { CostController, type PriceTable } from '../cost/controller.ts';
import { createAgentRegistry } from '../registry/agents.ts';
import { ProviderCatalog } from '../registry/providers.ts';
import { createToolRegistry } from '../registry/tools.ts';
import { FakeClock, createHarness, createProviderRegistry } from '../testing.ts';
import type { Budget, ProviderHealth } from '../types.ts';
import { SmartRouter, type RouteOptions } from './router.ts';

const KEY = 'sk-test-FAKEFAKEFAKE1234567890';

type RegistryOptions = Parameters<typeof createProviderRegistry>[0];

const OPENAI = { apiKey: KEY, models: ['gpt-test'] };
const ANTHROPIC = { apiKey: KEY, models: ['claude-test'] };
const GEMINI = { apiKey: KEY, models: ['gemini-test'] };

function setup(registryOptions: RegistryOptions = {}, options: { budget?: Budget; prices?: PriceTable; disabled?: string[] } = {}) {
  const { store } = createHarness();
  const clock = new FakeClock();
  const registry = createProviderRegistry({ mock: { minLatencyMs: 0, maxLatencyMs: 0 }, ...registryOptions });
  const agents = createAgentRegistry();
  const tools = createToolRegistry();
  const catalog = new ProviderCatalog(() => registry.describe());
  for (const id of options.disabled ?? []) catalog.disable(id, 'apagado por el operador');
  const cost = new CostController(store, options.budget, options.prices);
  const router = new SmartRouter(agents, catalog, tools, new PermissionPolicy(), cost, { clock });
  catalog.attachCircuit((id) => router.circuitState(id));
  const plan = new RulesPlanner(agents, tools).plan('Quiero lanzar una tienda online de cookies en Italia.');
  const step = plan.steps.find((s) => s.id === 's-strategy-positioning')!;
  const route = (o: RouteOptions = {}) => router.route(step, { missionId: 'm1', ...o });
  return { router, catalog, clock, route, registry, step };
}

const excludedCodes = (d: Awaited<ReturnType<ReturnType<typeof setup>['route']>>) =>
  Object.fromEntries((d.explanation?.excludedCandidates ?? []).map((e) => [`${e.providerId}${e.model !== null ? `/${e.model}` : ''}`, e.code]));

describe('smart router — real providers', () => {
  describe('selection', () => {
    it('picks the configured real provider and explains the choice as data', async () => {
      const { route } = setup({ openai: OPENAI });
      const d = await route();

      assert.equal(d.blocked, null);
      assert.equal(d.provider?.id, 'openai');
      assert.equal(d.provider?.model, 'gpt-test');
      assert.equal(d.execution, 'external');

      const ex = d.explanation!;
      assert.equal(ex.selectedProvider, 'openai');
      assert.equal(ex.selectedModel, 'gpt-test');
      assert.deepEqual(ex.candidates.filter((c) => c.selected).map((c) => `${c.providerId}/${c.model}`), ['openai/gpt-test']);
      assert.equal(ex.candidates[0]?.source, 'real');
      assert.ok(ex.reasons.length > 0);
      // Who was turned away, with a machine-readable code.
      const codes = excludedCodes(d);
      assert.equal(codes['anthropic'], 'unconfigured');
      assert.equal(codes['gemini'], 'unconfigured');
      assert.equal(codes['openai-compatible'], 'not_implemented');
      assert.equal(codes['mock/mock-1'], 'mock_last_resort');
      const unconfigured = ex.excludedCandidates.find((e) => e.providerId === 'anthropic')!;
      assert.equal(unconfigured.errorCode, 'PROVIDER_UNCONFIGURED');
      assert.match(unconfigured.reason, /ANTHROPIC_API_KEY/);
    });

    it('never selects an unconfigured provider, even one that would otherwise rank first', async () => {
      // A key without a model is not configured.
      const { route } = setup({ openai: { apiKey: KEY }, anthropic: ANTHROPIC });
      const d = await route();
      assert.equal(d.provider?.id, 'anthropic');
      assert.equal(excludedCodes(d)['openai'], 'unconfigured');
    });

    it('with nothing real configured it uses the simulation, says so, and lists every real provider as unconfigured', async () => {
      const { route } = setup({});
      const d = await route();
      assert.equal(d.provider?.id, 'mock');
      assert.equal(d.execution, 'simulated');
      assert.ok(d.warnings.some((w) => /simulaci[oó]n|simulad/i.test(w)));
      assert.equal(d.explanation?.selectedProvider, 'mock');
      assert.equal(d.explanation?.candidates.find((c) => c.selected)?.source, 'mock');
      const codes = excludedCodes(d);
      assert.deepEqual([codes['openai'], codes['anthropic'], codes['gemini']], ['unconfigured', 'unconfigured', 'unconfigured']);
    });

    it('excludes a provider the operator disabled', async () => {
      const { route } = setup({ openai: OPENAI, anthropic: ANTHROPIC }, { disabled: ['anthropic'] });
      const d = await route();
      assert.equal(d.provider?.id, 'openai');
      assert.equal(excludedCodes(d)['anthropic'], 'disabled');
    });

    it('skips a provider that already failed this step (and says why)', async () => {
      const { route } = setup({ openai: OPENAI, anthropic: ANTHROPIC });
      const d = await route({ avoidProviders: ['anthropic'] });
      assert.equal(d.provider?.id, 'openai');
      assert.equal(excludedCodes(d)['anthropic'], 'avoided');
    });

    it('breaks ties between equal providers the same way every time, whatever the registration order', async () => {
      const picks = new Set<string>();
      for (let i = 0; i < 12; i++) {
        const forward = setup({ openai: OPENAI, anthropic: ANTHROPIC, gemini: GEMINI });
        picks.add(`${(await forward.route()).provider?.id}`);
      }
      assert.deepEqual([...picks], ['anthropic'], 'equal tier, quality and price: the alphabetical id decides, always');

      // Registered in a different order, same answer.
      const reversed = new ProviderCatalog(() => createProviderRegistry({ mock: { minLatencyMs: 0, maxLatencyMs: 0 }, gemini: GEMINI, anthropic: ANTHROPIC, openai: OPENAI }).describe().reverse());
      const { store } = createHarness();
      const agents = createAgentRegistry();
      const tools = createToolRegistry();
      const router = new SmartRouter(agents, reversed, tools, new PermissionPolicy(), new CostController(store));
      const step = new RulesPlanner(agents, tools).plan('Quiero lanzar una tienda online de cookies en Italia.').steps.find((s) => s.id === 's-strategy-positioning')!;
      assert.equal((await router.route(step, { missionId: 'm' })).provider?.id, 'anthropic');
    });

    it('the explanation lists the fallbacks in order and the pinned mission never leaves its provider', async () => {
      const { route } = setup({ openai: OPENAI, anthropic: ANTHROPIC });
      const free = await route();
      assert.deepEqual(free.fallbacks.map((f) => f.providerId), ['openai']);

      const pinned = await route({ pin: { providerId: 'openai', model: 'gpt-test' } });
      assert.equal(pinned.provider?.id, 'openai');
      assert.equal(excludedCodes(pinned)['anthropic'], 'not_pinned');
    });

    it('a mission pinned to an unconfigured provider is blocked with PROVIDER_UNCONFIGURED — it is not sent anywhere else', async () => {
      const { route } = setup({ anthropic: ANTHROPIC });
      const d = await route({ pin: { providerId: 'openai' } });
      assert.equal(d.provider, null);
      assert.equal(d.blocked?.kind, 'provider_missing');
      assert.equal(d.blocked?.code, 'PROVIDER_UNCONFIGURED');
      assert.match(d.blocked?.reason ?? '', /No se ha enviado el paso a ningún otro/);
      assert.equal(d.explanation?.selectedProvider, null);
    });
  });

  describe('capabilities', () => {
    it('refuses to route a step that needs a capability the adapters do not implement', async () => {
      const { route } = setup({ openai: OPENAI, anthropic: ANTHROPIC });
      const d = await route({ requireCapabilities: ['toolCalling'] });
      assert.equal(d.provider, null);
      assert.equal(d.blocked?.code, 'PROVIDER_CAPABILITY_MISMATCH');
      const mismatches = d.explanation?.excludedCandidates.filter((e) => e.code === 'capability_mismatch') ?? [];
      assert.ok(mismatches.some((e) => e.providerId === 'openai'));
      assert.ok(mismatches.every((e) => e.errorCode === 'PROVIDER_CAPABILITY_MISMATCH'));
    });

    it('a text-only requirement is met by all of them', async () => {
      const { route } = setup({ openai: OPENAI });
      assert.equal((await route({ requireCapabilities: [] })).provider?.id, 'openai');
    });
  });

  describe('circuit breaker', () => {
    it('excludes a provider whose circuit is open, and names the code', async () => {
      const { route, router } = setup({ openai: OPENAI, anthropic: ANTHROPIC });
      for (let i = 0; i < 3; i++) router.recordFailure('anthropic');
      const d = await route();
      assert.equal(d.provider?.id, 'openai');
      const open = d.explanation?.excludedCandidates.find((e) => e.providerId === 'anthropic');
      assert.equal(open?.code, 'circuit_open');
      assert.equal(open?.errorCode, 'PROVIDER_CIRCUIT_OPEN');
    });

    it('brings a provider back on probation after the cooldown, and reports the transition once', async () => {
      const { route, router, clock } = setup({ openai: OPENAI, anthropic: ANTHROPIC });
      for (let i = 0; i < 3; i++) router.recordFailure('anthropic');
      assert.equal((await route()).provider?.id, 'openai');
      assert.deepEqual(router.takeCircuitTransitions(), [], 'still open: nothing to report');

      clock.advance(61_000);
      assert.equal((await route()).provider?.id, 'anthropic', 'half-open: offered again');
      assert.deepEqual(router.takeCircuitTransitions(), ['anthropic']);
      assert.deepEqual(router.takeCircuitTransitions(), [], 'reported once');
    });

    it('does NOT fall back to the simulation when the only configured real provider is out — the step is blocked', async () => {
      const { route, router } = setup({ openai: OPENAI });
      for (let i = 0; i < 3; i++) router.recordFailure('openai');
      const d = await route();
      assert.equal(d.provider, null, 'no simulated answer');
      assert.equal(d.execution, 'none');
      assert.equal(d.blocked?.kind, 'provider_missing');
      assert.equal(d.blocked?.code, 'PROVIDER_CIRCUIT_OPEN');
      assert.match(d.blocked?.reason ?? '', /No se sustituye por la simulación/);
      assert.equal(d.explanation?.candidates.some((c) => c.providerId === 'mock' && c.selected), false);
    });

    it('does not fall back to the simulation after the provider failed in this very step, either', async () => {
      const { route } = setup({ openai: OPENAI });
      const d = await route({ avoidProviders: ['openai'] });
      assert.equal(d.provider, null);
      assert.match(d.blocked?.reason ?? '', /No se sustituye por la simulación/);
    });

    it('does not fall back to the simulation when a provider was taken out of service (a rejected key)', async () => {
      const { route, router } = setup({ openai: OPENAI });
      router.markProviderUnusable('openai', 'OpenAI rechazó las credenciales (HTTP 401). Revisa OPENAI_API_KEY.');
      const d = await route();
      assert.equal(d.provider, null);
      assert.match(d.blocked?.reason ?? '', /rechazó las credenciales/);
      assert.equal(excludedCodes(d)['openai'], 'unusable');
      router.clearProviderFault('openai');
      assert.equal((await route()).provider?.id, 'openai');
    });

    it('a mission started on the simulation stays on it — that is a choice, not a fallback', async () => {
      const { route, router } = setup({ openai: OPENAI });
      for (let i = 0; i < 3; i++) router.recordFailure('openai');
      const d = await route({ pin: { providerId: 'mock', model: 'mock-1' } });
      assert.equal(d.provider?.id, 'mock');
    });
  });

  describe('cost and budget', () => {
    const BUDGET: Budget = { perMissionUsd: 1, dailyUsd: null, monthlyUsd: null, perAgentUsd: {}, perToolUsd: {}, alertAtFraction: 0.8, onExceed: 'block' };

    it('known price within budget: chosen, with a numeric estimate', async () => {
      const { route } = setup({ openai: OPENAI }, { budget: BUDGET, prices: { 'openai:gpt-test': { inputPer1kUsd: 0.001, outputPer1kUsd: 0.002 } } });
      const d = await route();
      assert.equal(d.provider?.id, 'openai');
      assert.equal(d.estimatedCostUsd, 0.0029); // 1.5k in + 0.7k out
      assert.equal(d.explanation?.candidates[0]?.estimatedCostUsd, 0.0029);
    });

    it('unknown price with a budget in force: rejected BEFORE anything is executed, with PROVIDER_COST_UNKNOWN', async () => {
      const { route } = setup({ openai: OPENAI }, { budget: BUDGET });
      const d = await route();
      assert.equal(d.provider, null);
      assert.equal(d.blocked?.kind, 'budget');
      assert.equal(d.blocked?.code, 'PROVIDER_COST_UNKNOWN');
      assert.match(d.blocked?.reason ?? '', /Se desconoce el precio/);
      const refused = d.explanation?.excludedCandidates.find((e) => e.providerId === 'openai');
      assert.equal(refused?.code, 'cost_unknown');
      assert.equal(refused?.errorCode, 'PROVIDER_COST_UNKNOWN');
    });

    it('unknown price with NO budget: follows the existing policy — it runs, and the cost stays unknown (never 0)', async () => {
      const { route } = setup({ openai: OPENAI });
      const d = await route();
      assert.equal(d.provider?.id, 'openai');
      assert.equal(d.estimatedCostUsd, null);
      assert.notEqual(d.estimatedCostUsd, 0);
      assert.ok(d.rationale.some((r) => /se desconoce el precio/i.test(r)));
    });

    it('a known price that does not fit the budget is refused as over budget, not as unknown', async () => {
      const tight: Budget = { ...BUDGET, perMissionUsd: 0.0001 };
      const { route } = setup({ openai: OPENAI }, { budget: tight, prices: { openai: { inputPer1kUsd: 0.001, outputPer1kUsd: 0.002 } } });
      const d = await route();
      assert.equal(d.provider, null);
      assert.equal(d.blocked?.kind, 'budget');
      assert.equal(d.blocked?.code, undefined, 'over budget is not an unknown price');
      assert.equal(d.explanation?.excludedCandidates.find((e) => e.providerId === 'openai')?.code, 'budget');
    });

    it('with a budget, it picks the provider whose price is known over one whose price is not', async () => {
      const { route } = setup({ openai: OPENAI, anthropic: ANTHROPIC }, { budget: BUDGET, prices: { 'openai:gpt-test': { inputPer1kUsd: 0.001, outputPer1kUsd: 0.002 } } });
      const d = await route();
      assert.equal(d.provider?.id, 'openai');
      assert.equal(d.explanation?.excludedCandidates.find((e) => e.providerId === 'anthropic')?.code, 'cost_unknown');
    });
  });

  describe('health', () => {
    const down = (checkedAt: string): ProviderHealth => ({ status: 'down', checkedAt, latencyMs: 5, detail: 'no responde' });

    it('a provider whose probe just failed goes behind a healthy one — it is not excluded', async () => {
      const { route, catalog, clock } = setup({ openai: OPENAI, anthropic: ANTHROPIC });
      catalog.recordHealth('anthropic', down(clock.now().toISOString())); // anthropic would win the tie
      const d = await route();
      assert.equal(d.provider?.id, 'openai');
      assert.ok(d.explanation?.candidates.some((c) => c.providerId === 'anthropic'), 'still a candidate, and a fallback');
    });

    it('a stale failed probe no longer counts', async () => {
      const { route, catalog, clock } = setup({ openai: OPENAI, anthropic: ANTHROPIC });
      catalog.recordHealth('anthropic', down(clock.now().toISOString()));
      clock.advance(5 * 60_000);
      assert.equal((await route()).provider?.id, 'anthropic');
    });

    it('if the only provider is down it is still tried, with a warning', async () => {
      const { route, catalog, clock } = setup({ openai: OPENAI });
      catalog.recordHealth('openai', down(clock.now().toISOString()));
      const d = await route();
      assert.equal(d.provider?.id, 'openai');
      assert.ok(d.warnings.some((w) => /última comprobación/.test(w)));
    });

    it('configured is not healthy: a provider with a key stays unknown until something answers', async () => {
      const { catalog } = setup({ openai: OPENAI });
      const openai = catalog.get('openai')!;
      assert.equal(openai.configured, true);
      assert.equal(openai.available, true);
      assert.equal(openai.healthy, null);
      assert.equal(openai.health.status, 'unknown');
      catalog.recordHealth('openai', { status: 'ok', checkedAt: '2026-09-19T12:00:00.000Z', latencyMs: 40, detail: 'responde' });
      assert.equal(catalog.get('openai')!.healthy, true);
      catalog.recordHealth('openai', down('2026-09-19T12:01:00.000Z'));
      assert.equal(catalog.get('openai')!.healthy, false);
    });

    it('an unconfigured provider is never healthy', () => {
      const { catalog } = setup({});
      const openai = catalog.get('openai')!;
      assert.deepEqual([openai.configured, openai.available, openai.executable, openai.healthy], [false, false, false, null]);
      assert.equal(openai.status, 'UNCONFIGURED');
      assert.equal(openai.health.status, 'not_connected');
    });
  });
});
