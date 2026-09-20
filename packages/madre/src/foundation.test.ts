import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ApprovalError, ApprovalService } from './permissions/approvals.ts';
import { PermissionPolicy, PERMISSION_LEVELS } from './permissions/policy.ts';
import { NO_BUDGET, CostController } from './cost/controller.ts';
import { MemoryService } from './memory/service.ts';
import { createAgentRegistry } from './registry/agents.ts';
import { ProviderCatalog, profileLocalModel } from './registry/providers.ts';
import { createToolRegistry } from './registry/tools.ts';
import { createHarness } from './testing.ts';

describe('agent registry', () => {
  it('has the eight active agents and no active agent holding a dangerous permission', () => {
    const registry = createAgentRegistry();
    assert.deepEqual(
      registry.active().map((a) => a.id).sort(),
      ['design', 'engineering', 'finance', 'integrator', 'marketing', 'qa', 'research', 'strategy'],
    );
    for (const agent of registry.list()) {
      if (agent.status === 'active') {
        assert.ok(!agent.permissions.includes('FINANCIAL'), `${agent.id} must not hold FINANCIAL`);
        assert.ok(!agent.permissions.includes('PUBLISH'), `${agent.id} must not hold PUBLISH`);
      }
    }
  });

  it('declares planned agents without activating them', () => {
    const registry = createAgentRegistry();
    const planned = registry.list().filter((a) => a.status === 'planned');
    assert.ok(planned.length >= 10);
    assert.ok(planned.some((a) => a.id === 'trading_research'));
    assert.equal(registry.forCapability('trading.research').length, 0);
    assert.ok(registry.plannedFor('trading.research').length > 0);
  });

  it('refuses to activate an agent that holds FINANCIAL', () => {
    const registry = createAgentRegistry();
    const risky = registry.list().find((a) => a.permissions.includes('FINANCIAL') && a.status === 'planned');
    if (risky) assert.throws(() => registry.setStatus(risky.id, 'active'));
  });

  it('references only tool ids that exist in the tool registry', () => {
    const tools = createToolRegistry();
    for (const agent of createAgentRegistry().list()) {
      for (const id of agent.requiredTools) assert.ok(tools.get(id), `${agent.id} requires unknown tool ${id}`);
    }
  });
});

describe('tool registry', () => {
  it('never reports an external service as connected', () => {
    const tools = createToolRegistry();
    for (const t of tools.list()) {
      if (t.locality !== 'local') assert.ok(!['AVAILABLE', 'CONNECTED'].includes(t.status), `${t.id} is remote but ${t.status}`);
    }
  });

  it('keeps code execution disabled and publishing tools not connected', () => {
    const tools = createToolRegistry();
    assert.equal(tools.get('sandbox.exec')?.status, 'DISABLED');
    assert.equal(tools.get('distribution.tiktok')?.status, 'NOT_CONNECTED');
    assert.equal(tools.isUsable('sandbox.exec'), false);
    assert.equal(tools.isUsable('math.calculator'), true);
  });

  it('finds usable tools by capability and rejects duplicate ids', () => {
    const tools = createToolRegistry();
    assert.deepEqual(tools.forCapability('finance.unit_economics').map((t) => t.id), ['math.calculator']);
    assert.equal(tools.forCapability('research.web').length, 0);
    assert.ok(tools.anyFor('research.web').length > 0);
    assert.throws(() => tools.register(tools.get('math.calculator')!));
  });
});

describe('provider catalog', () => {
  const source = () => [
    { id: 'mock' as const, label: 'Mock', availability: 'available' as const, models: [{ id: 'mock-1', label: 'Mock 1' }] },
    { id: 'openai' as const, label: 'OpenAI', availability: 'planned' as const, models: [], note: 'stub' },
  ];

  it('marks the mock as MOCK and planned providers as NOT_CONNECTED', () => {
    const profiles = new ProviderCatalog(source).profiles();
    assert.equal(profiles.find((p) => p.id === 'mock')?.status, 'MOCK');
    assert.equal(profiles.find((p) => p.id === 'openai')?.status, 'NOT_CONNECTED');
    assert.equal(profiles.find((p) => p.id === 'ollama')?.status, 'NOT_CONNECTED');
    assert.ok(profiles.filter((p) => p.tier === 'specialized').every((p) => !p.executable));
  });

  it('shows an available local provider as LOCAL and reports errors', () => {
    const catalog = new ProviderCatalog(() => [
      { id: 'ollama', label: 'Ollama', availability: 'available', models: [{ id: 'llama3.1:70b', label: '70b' }] },
    ]);
    const ollama = catalog.get('ollama')!;
    assert.equal(ollama.status, 'LOCAL');
    assert.equal(ollama.models[0]?.tier, 'local_strong');
    catalog.markError('ollama', 'connection refused');
    assert.equal(catalog.get('ollama')?.status, 'ERROR');
    assert.equal(catalog.get('ollama')?.executable, false);
    catalog.clearError('ollama');
    assert.equal(catalog.get('ollama')?.executable, true);
  });

  it('rates local models by size and never invents a price for external ones', () => {
    assert.equal(profileLocalModel('qwen2.5:3b').quality, 2);
    assert.equal(profileLocalModel('llama3.1:8b').quality, 3);
    assert.equal(profileLocalModel('llama3.1:70b').tier, 'local_strong');
    const external = new ProviderCatalog(() => [
      { id: 'anthropic', label: 'A', availability: 'available', models: [{ id: 'x', label: 'x' }] },
    ]).get('anthropic')!;
    assert.equal(external.models[0]?.pricePer1kInputUsd, null);
  });
});

describe('permission policy', () => {
  it('never allows FINANCIAL, PUBLISH, EXTERNAL_ACTION or DELETE automatically', () => {
    for (const overrides of [{}, { FINANCIAL: 'AUTO' as const, PUBLISH: 'AUTO' as const, EXTERNAL_ACTION: 'AUTO' as const, DELETE: 'AUTO' as const }]) {
      const policy = new PermissionPolicy(overrides);
      for (const level of ['FINANCIAL', 'PUBLISH', 'EXTERNAL_ACTION', 'DELETE'] as const) {
        assert.notEqual(policy.evaluate({ level, subject: 's', description: 'd' }).mode, 'AUTO', level);
      }
    }
  });

  it('allows internal reads and writes, asks for external writes and blocks execution by default', () => {
    const policy = new PermissionPolicy();
    assert.equal(policy.evaluate({ level: 'READ', subject: 'memory', description: '' }).mode, 'AUTO');
    assert.equal(policy.evaluate({ level: 'WRITE', subject: 'memory', description: '', internal: true }).mode, 'AUTO');
    assert.equal(policy.evaluate({ level: 'WRITE', subject: 'disk', description: '' }).mode, 'ASK');
    assert.equal(policy.evaluate({ level: 'EXECUTE', subject: 'code', description: '' }).mode, 'BLOCK');
    assert.equal(policy.evaluate({ level: 'FINANCIAL', subject: 'pay', description: '' }).mode, 'BLOCK');
  });

  it('lets an operator tighten but never loosen past the floor', () => {
    const policy = new PermissionPolicy({ READ: 'BLOCK', EXECUTE: 'AUTO', PUBLISH: 'BLOCK' });
    assert.equal(policy.evaluate({ level: 'READ', subject: 'x', description: '' }).mode, 'BLOCK');
    assert.equal(policy.evaluate({ level: 'EXECUTE', subject: 'x', description: '' }).mode, 'ASK');
    assert.equal(policy.evaluate({ level: 'PUBLISH', subject: 'x', description: '' }).mode, 'BLOCK');
    assert.deepEqual(Object.keys(policy.configured()).sort(), [...PERMISSION_LEVELS].sort());
  });

  it('treats any action that moves money as financial', () => {
    const decision = new PermissionPolicy().evaluate({ level: 'READ', subject: 'x', description: '', amountUsd: 5 });
    assert.equal(decision.level, 'FINANCIAL');
    assert.equal(decision.mode, 'BLOCK');
  });
});

describe('approvals', () => {
  it('moves out of pending exactly once', async () => {
    const { store } = createHarness();
    const approvals = new ApprovalService(store);
    const a = await approvals.request({ missionId: 'm', runId: 'r', stepId: 's', kind: 'permission', level: 'PUBLISH', title: 't', detail: 'd' });
    assert.equal((await approvals.pending()).length, 1);
    const decided = await approvals.decide(a.id, 'approved', 'ok');
    assert.equal(decided.status, 'approved');
    assert.equal((await approvals.pending()).length, 0);
    await assert.rejects(() => approvals.decide(a.id, 'denied'), (e: unknown) => e instanceof ApprovalError && e.code === 'already_decided');
    await assert.rejects(() => approvals.decide('nope', 'denied'), (e: unknown) => e instanceof ApprovalError && e.code === 'not_found');
  });
});

describe('cost controller', () => {
  it('records free providers as zero and unknown external prices as unpriced', async () => {
    const { store } = createHarness();
    const cost = new CostController(store);
    await cost.record({ missionId: 'm', provider: 'mock', model: 'mock-1', promptTokens: 100, completionTokens: 50, agentId: 'strategy' });
    await cost.record({ missionId: 'm', provider: 'openai', model: 'x', promptTokens: 100, completionTokens: 50, agentId: 'research' });
    const summary = await cost.summary({ missionId: 'm' });
    assert.equal(summary.calls, 2);
    assert.equal(summary.unpricedCalls, 1);
    assert.equal(summary.knownUsd, 0);
    assert.equal(summary.promptTokens, 200);
  });

  it('prices from the configured table and prefers the model-specific entry', async () => {
    const { store } = createHarness();
    const cost = new CostController(store, undefined, {
      openai: { inputPer1kUsd: 1, outputPer1kUsd: 2 },
      'openai:big': { inputPer1kUsd: 10, outputPer1kUsd: 20 },
    });
    assert.equal(cost.estimate('openai', 'small', 1000, 1000), 3);
    assert.equal(cost.estimate('openai', 'big', 1000, 1000), 30);
    assert.equal(cost.estimate('anthropic', 'x', 1000, 1000), null);
  });

  it('blocks or falls back when a budget would be crossed, and never blocks free providers', async () => {
    const { store } = createHarness();
    const cost = new CostController(
      store,
      { perMissionUsd: 1, dailyUsd: null, monthlyUsd: null, perAgentUsd: {}, perToolUsd: {}, alertAtFraction: 0.8, onExceed: 'fallback_local' },
      { openai: { inputPer1kUsd: 1, outputPer1kUsd: 1 } },
    );
    await cost.record({ missionId: 'm', provider: 'openai', promptTokens: 400, completionTokens: 400, agentId: 'a' });
    const over = await cost.check({ missionId: 'm', providerId: 'openai', estimatedUsd: 0.5 });
    assert.equal(over.allowed, false);
    assert.equal(over.action, 'fallback_local');
    assert.match(over.reason ?? '', /presupuesto de la misión/);
    const free = await cost.check({ missionId: 'm', providerId: 'ollama', estimatedUsd: 0 });
    assert.equal(free.allowed, true);
    const ok = await cost.check({ missionId: 'm', providerId: 'openai', estimatedUsd: 0.1 });
    assert.equal(ok.allowed, true);
  });

  it('cannot verify a budget against an unknown price', async () => {
    const { store } = createHarness();
    const cost = new CostController(store, { perMissionUsd: 5, dailyUsd: null, monthlyUsd: null, perAgentUsd: {}, perToolUsd: {}, alertAtFraction: 0.8, onExceed: 'block' });
    const check = await cost.check({ missionId: 'm', providerId: 'openai', estimatedUsd: null });
    assert.equal(check.allowed, false);
    assert.equal(check.action, 'block');
  });

  it('enforces per-agent budgets', async () => {
    const { store } = createHarness();
    const cost = new CostController(
      store,
      { ...NO_BUDGET, perAgentUsd: { research: 0.2 }, onExceed: 'block' },
      { openai: { inputPer1kUsd: 1, outputPer1kUsd: 1 } },
    );
    const check = await cost.check({ missionId: 'm', agentId: 'research', providerId: 'openai', estimatedUsd: 0.5 });
    assert.equal(check.allowed, false);
    assert.match(check.reason ?? '', /presupuesto del agente research/);
  });
});

describe('memory service', () => {
  it('stores agent output as an unverified result, never a fact', async () => {
    const { store } = createHarness();
    const memory = new MemoryService(store);
    const { entry, adjustments } = await memory.remember({
      type: 'fact', title: 'Market size', content: 'The market is huge.', origin: 'agent', verified: true, confidence: 0.99,
    });
    assert.equal(entry.type, 'result');
    assert.equal(entry.verified, false);
    assert.equal(entry.confidence, 0.6);
    assert.ok(adjustments.length >= 2);
  });

  it('accepts verification from the user, and from a tool only with a reference', async () => {
    const { store } = createHarness();
    const memory = new MemoryService(store);
    const user = await memory.remember({ type: 'fact', title: 'Base', content: 'Lives in Milan.', origin: 'user', verified: true });
    assert.equal(user.entry.type, 'fact');
    assert.equal(user.entry.verified, true);
    const toolNoRef = await memory.remember({ type: 'fact', title: 'x', content: 'y', origin: 'tool', verified: true });
    assert.equal(toolNoRef.entry.verified, false);
    const toolRef = await memory.remember({ type: 'fact', title: 'sum', content: '2+2=4', origin: 'tool', ref: 'math.calculator', verified: true });
    assert.equal(toolRef.entry.verified, true);
  });

  it('recalls by relevance, honours scope and verification filters', async () => {
    const { store } = createHarness();
    const memory = new MemoryService(store);
    await memory.remember({ type: 'preference', title: 'Cookies budget', content: 'Keep the cookies launch under 5k euro.', origin: 'user', scope: 'user' });
    await memory.remember({ type: 'result', title: 'Logistics note', content: 'Shipping is slow in summer.', origin: 'agent', scope: 'project' });
    const hits = await memory.recall({ query: 'cookies launch' });
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.entry.title, 'Cookies budget');
    assert.equal((await memory.recall({ scope: 'project' })).length, 1);
    assert.equal((await memory.recall({ onlyVerified: true })).length, 0);
    assert.equal((await memory.recall({ query: 'zzzz' })).length, 0);
  });

  it('expires temporary entries', async () => {
    const { store, clock } = createHarness();
    const memory = new MemoryService(store);
    await memory.remember({ type: 'temporary', title: 'scratch', content: 'draft', origin: 'system' });
    assert.equal((await memory.list()).length, 1);
    clock.advance(25 * 3600 * 1000);
    assert.equal((await memory.list()).length, 0);
    assert.equal((await memory.list({ includeExpired: true })).length, 1);
    assert.equal(await memory.expire(), 1);
  });

  it('records lessons as unverified system entries and counts them', async () => {
    const { store } = createHarness();
    const memory = new MemoryService(store);
    await memory.recordLesson({ title: 'Provider timed out', content: 'Retry with a smaller prompt.', missionId: 'm1' });
    const stats = await memory.stats();
    assert.equal(stats.lessons, 1);
    assert.equal(stats.verified, 0);
    assert.equal(stats.byType.lesson, 1);
  });
});
