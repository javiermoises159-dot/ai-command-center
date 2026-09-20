import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ProviderDescriptor } from '@acc/domain';

import { RulesPlanner } from '../compiler/planner.ts';
import { NO_BUDGET, CostController } from '../cost/controller.ts';
import { PermissionPolicy } from '../permissions/policy.ts';
import { createAgentRegistry } from '../registry/agents.ts';
import { ProviderCatalog } from '../registry/providers.ts';
import { createToolRegistry } from '../registry/tools.ts';
import { createHarness } from '../testing.ts';
import type { Budget } from '../types.ts';
import { computePriorities, SmartRouter } from './router.ts';

const MOCK: ProviderDescriptor = { id: 'mock', label: 'Mock', availability: 'available', models: [{ id: 'mock-1', label: 'Mock' }] };
const OLLAMA_SMALL: ProviderDescriptor = { id: 'ollama', label: 'Ollama', availability: 'available', models: [{ id: 'llama3.2:3b', label: '3b' }] };
const OLLAMA_MIXED: ProviderDescriptor = {
  id: 'ollama',
  label: 'Ollama',
  availability: 'available',
  models: [{ id: 'llama3.2:3b', label: '3b' }, { id: 'llama3.1:8b', label: '8b' }, { id: 'llama3.1:70b', label: '70b' }],
};
const CLAUDE: ProviderDescriptor = { id: 'anthropic', label: 'Anthropic', availability: 'available', models: [{ id: 'big', label: 'big' }] };

function setup(descriptors: ProviderDescriptor[], options: { budget?: Budget; overrides?: ConstructorParameters<typeof PermissionPolicy>[0] } = {}) {
  const { store } = createHarness();
  const agents = createAgentRegistry();
  const tools = createToolRegistry();
  const catalog = new ProviderCatalog(() => descriptors);
  const cost = new CostController(store, options.budget);
  const router = new SmartRouter(agents, catalog, tools, new PermissionPolicy(options.overrides), cost);
  const planner = new RulesPlanner(agents, tools);
  const plan = planner.plan('Quiero lanzar una tienda online de cookies en Italia.');
  const step = (id: string) => plan.steps.find((s) => s.id === id)!;
  return { router, plan, step, catalog, tools, cost };
}

describe('smart router', () => {
  it('uses the simulated provider only when nothing real is connected, and says so', async () => {
    const { router, step } = setup([MOCK]);
    const d = await router.route(step('s-research-market'));
    assert.equal(d.provider?.id, 'mock');
    assert.equal(d.execution, 'simulated');
    assert.ok(d.confidence <= 0.3);
    assert.ok(d.warnings.some((w) => /simulad/i.test(w)));
    assert.equal(d.blocked, null);
  });

  it('prefers local over external when a local model is good enough', async () => {
    const { router, step } = setup([MOCK, OLLAMA_MIXED, CLAUDE]);
    const easy = await router.route(step('s-design-brand')); // difficulty 2 -> needs 3
    assert.equal(easy.provider?.id, 'ollama');
    assert.equal(easy.provider?.model, 'llama3.1:8b');
    assert.equal(easy.execution, 'local');
    assert.equal(easy.needsExternalService, false);
  });

  it('climbs to a stronger local model for hard steps', async () => {
    const { router, step } = setup([OLLAMA_MIXED, CLAUDE]);
    const hard = await router.route(step('s-strategy-positioning')); // difficulty 4
    assert.equal(hard.provider?.model, 'llama3.1:70b');
    assert.equal(hard.provider?.tier, 'local_strong');
  });

  it('goes external when local models are too weak for a hard step, and lists fallbacks', async () => {
    const { router, step } = setup([OLLAMA_SMALL, CLAUDE]);
    const hard = await router.route(step('s-strategy-positioning'));
    assert.equal(hard.provider?.id, 'anthropic');
    assert.equal(hard.execution, 'external');
    assert.equal(hard.needsExternalService, true);
    assert.deepEqual(hard.fallbacks.map((f) => f.providerId), ['ollama']);
    assert.equal(hard.estimatedCostUsd, null);
    assert.ok(hard.rationale.some((r) => /se desconoce el precio/i.test(r)));
  });

  it('warns and lowers confidence when only weak models exist', async () => {
    const { router, step } = setup([OLLAMA_SMALL]);
    const d = await router.route(step('s-strategy-positioning'));
    assert.equal(d.provider?.id, 'ollama');
    assert.ok(d.warnings.some((w) => /2\/5/.test(w) && /4\/5/.test(w)));
    assert.ok(d.confidence < 0.5);
  });

  it('never sends sensitive input to a third party', async () => {
    const { router, step } = setup([CLAUDE]);
    const s = structuredClone(step('s-research-market'));
    s.task.sensitive = true;
    const d = await router.route(s);
    assert.equal(d.provider, null);
    assert.equal(d.blocked?.kind, 'privacy');

    const withLocal = setup([OLLAMA_MIXED, CLAUDE]);
    const s2 = structuredClone(withLocal.step('s-research-market'));
    s2.task.sensitive = true;
    const ok = await withLocal.router.route(s2);
    assert.equal(ok.provider?.id, 'ollama');
  });

  it('blocks when no provider is connected at all', async () => {
    const { router, step } = setup([{ id: 'openai', label: 'OpenAI', availability: 'planned', models: [] }]);
    const d = await router.route(step('s-research-market'));
    assert.equal(d.blocked?.kind, 'provider_missing');
    assert.equal(d.execution, 'none');
  });

  it('blocks a planned agent instead of scheduling it', async () => {
    const { router, step } = setup([MOCK]);
    const s = structuredClone(step('s-research-market'));
    s.agentId = 'trading_research';
    const d = await router.route(s);
    assert.equal(d.blocked?.kind, 'agent_planned');
  });

  it('runs without an unavailable optional tool but blocks on a required one', async () => {
    const { router, step } = setup([MOCK]);
    const research = await router.route(step('s-research-market'));
    const web = research.tools.find((t) => t.toolId === 'web.search')!;
    assert.equal(web.usable, false);
    assert.equal(web.status, 'NOT_CONNECTED');
    assert.equal(research.blocked, null);
    assert.ok(research.warnings.some((w) => w.includes('web.search')));
    assert.ok(research.warnings.some((w) => /información actual/i.test(w)));

    const s = structuredClone(step('s-research-market'));
    s.toolRequests = [{ id: 'x', toolId: 'web.search', purpose: 'p', input: {}, permission: 'READ', required: true }];
    const blocked = await router.route(s);
    assert.equal(blocked.blocked?.kind, 'tool_missing');
  });

  it('enforces the budget: falls back to local, blocks, or asks', async () => {
    const zero = (onExceed: Budget['onExceed']): Budget => ({ ...NO_BUDGET, perMissionUsd: 0.0001, onExceed });
    // Unknown price + a budget => cannot verify => external is refused.
    const fb = setup([OLLAMA_SMALL, CLAUDE], { budget: zero('fallback_local') });
    const d = await fb.router.route(fb.step('s-strategy-positioning'));
    assert.equal(d.provider?.id, 'ollama');
    assert.ok(d.warnings.some((w) => /descartado/.test(w)));

    const blocked = setup([CLAUDE], { budget: zero('block') });
    assert.equal((await blocked.router.route(blocked.step('s-strategy-positioning'))).blocked?.kind, 'budget');

    const ask = setup([CLAUDE], { budget: zero('ask') });
    const asked = await ask.router.route(ask.step('s-strategy-positioning'));
    assert.equal(asked.requiresApproval, true);
    assert.equal(asked.provider?.id, 'anthropic');
  });

  it('asks for approval when a tool call needs it', async () => {
    const { router, step } = setup([MOCK]);
    const s = structuredClone(step('s-research-market'));
    s.toolRequests = [{ id: 'x', toolId: 'math.calculator', purpose: 'p', input: {}, permission: 'DELETE', required: false }];
    const d = await router.route(s);
    assert.equal(d.requiresApproval, true);
    assert.ok(d.approvalReasons.length > 0);
  });

  it('gives an input step no provider and a required approval', async () => {
    const { router } = setup([MOCK]);
    const plan = new RulesPlanner(createAgentRegistry(), createToolRegistry()).plan('Analiza estos documentos y dime las acciones prioritarias.');
    const input = plan.steps.find((s) => s.kind === 'input')!;
    const d = await router.route(input);
    assert.equal(d.provider, null);
    assert.equal(d.blocked, null);
    assert.equal(d.requiresApproval, true);
  });

  it('avoids providers that just failed', async () => {
    const { router, step } = setup([OLLAMA_MIXED, CLAUDE]);
    const d = await router.route(step('s-design-brand'), { avoidProviders: ['ollama'] });
    assert.equal(d.provider?.id, 'anthropic');
  });

  it('is deterministic', async () => {
    const a = setup([OLLAMA_MIXED, CLAUDE]);
    const b = setup([OLLAMA_MIXED, CLAUDE]);
    assert.deepEqual(await a.router.route(a.step('s-finance-unit-economics')), await b.router.route(b.step('s-finance-unit-economics')));
  });

  it('gives the critical path priority 1 and routes a whole plan', async () => {
    const { router, plan } = setup([MOCK]);
    const priorities = computePriorities(plan);
    assert.equal(Math.min(...priorities.values()), 1);
    assert.ok(priorities.get('s-integrate')! > priorities.get('s-strategy-positioning')!);
    const decisions = await router.routePlan(plan);
    assert.equal(decisions.size, plan.steps.length);
    assert.ok([...decisions.values()].every((d) => d.blocked === null));
  });
});
