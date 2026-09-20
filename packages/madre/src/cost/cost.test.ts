import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createHarness } from '../testing.ts';
import type { Budget } from '../types.ts';
import { CostController, DEFAULT_ALERT_AT_FRACTION, NO_BUDGET } from './controller.ts';

const PRICES = { openai: { inputPer1kUsd: 1, outputPer1kUsd: 1 } };

function budget(overrides: Partial<Budget> = {}): Budget {
  return { ...NO_BUDGET, perAgentUsd: {}, perToolUsd: {}, ...overrides };
}

describe('cost controller: per-tool budgets', () => {
  it('blocks a tool call that would cross the tool ceiling', async () => {
    const { store } = createHarness();
    const cost = new CostController(store, budget({ perToolUsd: { 'web.search': 0.1 } }), PRICES);
    await cost.record({ missionId: 'm', provider: 'web.search', kind: 'tool', agentId: 'research', actualUsd: 0.09 });

    const check = await cost.check({
      missionId: 'm',
      agentId: 'research',
      providerId: 'web.search',
      toolId: 'web.search',
      estimatedUsd: 0.05,
    });
    assert.equal(check.allowed, false);
    assert.equal(check.action, 'block');
    assert.match(check.reason ?? '', /presupuesto de la herramienta web\.search/);
  });

  it('lets a tool call through while it fits, and ignores other tools ceilings', async () => {
    const { store } = createHarness();
    const cost = new CostController(store, budget({ perToolUsd: { 'web.search': 0.1 } }), PRICES);
    await cost.record({ missionId: 'm', provider: 'web.search', kind: 'tool', actualUsd: 0.02 });

    const same = await cost.check({ missionId: 'm', providerId: 'web.search', toolId: 'web.search', estimatedUsd: 0.03 });
    assert.equal(same.allowed, true);
    assert.equal(same.action, 'proceed');
    assert.equal(same.reason, null);

    // A tool with no ceiling of its own is not held to another tool's limit.
    const other = await cost.check({ missionId: 'm', providerId: 'web.fetch', toolId: 'web.fetch', estimatedUsd: 5 });
    assert.equal(other.allowed, true);
  });

  it('scopes tool spend to the mission and to tool records', async () => {
    const { store } = createHarness();
    const cost = new CostController(store, budget({ perToolUsd: { 'web.search': 0.1 } }), PRICES);
    // Another mission, and a model call that merely shares the name: neither counts.
    await cost.record({ missionId: 'other', provider: 'web.search', kind: 'tool', actualUsd: 0.09 });
    await cost.record({ missionId: 'm', provider: 'web.search', kind: 'model', actualUsd: 0.09 });

    const check = await cost.check({ missionId: 'm', providerId: 'web.search', toolId: 'web.search', estimatedUsd: 0.005 });
    assert.equal(check.allowed, true);
  });
});

describe('cost controller: alerts', () => {
  it('warns once the call commits the alert fraction of a ceiling, and not before', async () => {
    const { store } = createHarness();
    const cost = new CostController(store, budget({ perMissionUsd: 1, alertAtFraction: 0.8 }), PRICES);
    await cost.record({ missionId: 'm', provider: 'openai', promptTokens: 250, completionTokens: 250 }); // 0.5 USD

    const quiet = await cost.check({ missionId: 'm', providerId: 'openai', estimatedUsd: 0.2 });
    assert.equal(quiet.allowed, true);
    assert.deepEqual(quiet.alerts, []);

    const loud = await cost.check({ missionId: 'm', providerId: 'openai', estimatedUsd: 0.35 });
    assert.equal(loud.allowed, true, 'an alert never blocks');
    assert.equal(loud.action, 'proceed');
    assert.equal(loud.reason, null);
    assert.equal(loud.alerts.length, 1);
    const alert = loud.alerts[0];
    assert.ok(alert);
    assert.equal(alert.scope, 'mission');
    assert.equal(alert.subject, null);
    assert.equal(alert.limitUsd, 1);
    assert.equal(alert.spentUsd, 0.85);
    assert.equal(alert.usedFraction, 0.85);
    assert.match(alert.message, /0\.85 USD/);
    assert.match(alert.message, /1 USD/);
    assert.match(alert.message, /85 %/);
  });

  it('warns about agent and tool ceilings, naming the subject', async () => {
    const { store } = createHarness();
    const cost = new CostController(
      store,
      budget({ perAgentUsd: { research: 0.1 }, perToolUsd: { 'web.search': 0.1 }, alertAtFraction: 0.8 }),
      PRICES,
    );
    await cost.record({ missionId: 'm', provider: 'web.search', kind: 'tool', agentId: 'research', actualUsd: 0.085 });

    const check = await cost.check({
      missionId: 'm',
      agentId: 'research',
      providerId: 'web.search',
      toolId: 'web.search',
      estimatedUsd: 0,
    });
    assert.equal(check.allowed, true);
    assert.deepEqual(check.alerts.map((a) => a.scope).sort(), ['agent', 'tool']);
    const tool = check.alerts.find((a) => a.scope === 'tool');
    assert.equal(tool?.subject, 'web.search');
    assert.match(tool?.message ?? '', /herramienta web\.search/);
    const agent = check.alerts.find((a) => a.scope === 'agent');
    assert.match(agent?.message ?? '', /agente research/);
  });

  it('stays silent when alerts are switched off, and when the ceiling is actually crossed', async () => {
    const { store } = createHarness();
    const cost = new CostController(store, budget({ perMissionUsd: 1, alertAtFraction: null }), PRICES);
    await cost.record({ missionId: 'm', provider: 'openai', promptTokens: 450, completionTokens: 450 }); // 0.9 USD
    const silent = await cost.check({ missionId: 'm', providerId: 'openai', estimatedUsd: 0.05 });
    assert.equal(silent.allowed, true);
    assert.deepEqual(silent.alerts, []);

    const warning = new CostController(store, budget({ perMissionUsd: 1, alertAtFraction: 0.8 }), PRICES);
    const blocked = await warning.check({ missionId: 'm', providerId: 'openai', estimatedUsd: 0.5 });
    assert.equal(blocked.allowed, false);
    // The crossed ceiling is the reason, not an alert.
    assert.equal(
      blocked.alerts.some((a) => a.scope === 'mission'),
      false,
    );
  });

  it('counts the day against the daily ceiling with the mission clock', async () => {
    const { store, clock } = createHarness();
    const cost = new CostController(store, budget({ dailyUsd: 1, alertAtFraction: 0.8 }), PRICES);
    await cost.record({ missionId: 'm', provider: 'openai', promptTokens: 450, completionTokens: 450 }); // 0.9 USD today
    const today = await cost.check({ missionId: 'm', providerId: 'openai', estimatedUsd: 0.05 });
    assert.equal(today.alerts.length, 1);
    assert.equal(today.alerts[0]?.scope, 'daily');

    clock.advance(24 * 60 * 60 * 1000);
    const tomorrow = await cost.check({ missionId: 'm', providerId: 'openai', estimatedUsd: 0.05 });
    assert.deepEqual(tomorrow.alerts, []);
    assert.equal(tomorrow.remainingUsd.daily, 1);
  });
});

describe('cost controller: summaries', () => {
  it('groups tool calls under byTool and keeps them unpriced unless a real cost is reported', async () => {
    const { store } = createHarness();
    const cost = new CostController(store, NO_BUDGET, PRICES);
    await cost.record({ missionId: 'm', provider: 'web.search', kind: 'tool', agentId: 'research', actualUsd: 0.02 });
    await cost.record({ missionId: 'm', provider: 'web.search', kind: 'tool', agentId: 'research' });
    await cost.record({ missionId: 'm', provider: 'memory.write', kind: 'tool', actualUsd: 0 });
    await cost.record({ missionId: 'm', provider: 'openai', promptTokens: 100, completionTokens: 100, agentId: 'research' });

    const summary = await cost.summary({ missionId: 'm' });
    assert.deepEqual(summary.byTool, {
      'web.search': { calls: 2, usd: 0.02 },
      'memory.write': { calls: 1, usd: 0 },
    });
    assert.ok(!('openai' in summary.byTool), 'a model call is not a tool');
    // One tool call had no reported cost, so the total is a lower bound.
    assert.equal(summary.unpricedCalls, 1);
    assert.equal(summary.knownUsd, 0.22);
    assert.equal(summary.byAgent['research']?.calls, 3);
  });

  it('prefers the reported cost over the estimate', async () => {
    const { store } = createHarness();
    const cost = new CostController(store, NO_BUDGET, PRICES);
    const record = await cost.record({
      missionId: 'm',
      provider: 'openai',
      promptTokens: 100,
      completionTokens: 50,
      actualUsd: 0.25,
    });
    assert.equal(record.estimatedUsd, 0.15);
    assert.equal(record.actualUsd, 0.25);

    const summary = await cost.summary({ missionId: 'm' });
    assert.equal(summary.knownUsd, 0.25);
    assert.equal(summary.unpricedCalls, 0);
    assert.equal(summary.byProvider['openai']?.usd, 0.25);
  });

  it('spends a reported tool cost against the mission budget', async () => {
    const { store } = createHarness();
    const cost = new CostController(store, budget({ perMissionUsd: 0.1 }), PRICES);
    await cost.record({ missionId: 'm', provider: 'web.search', kind: 'tool', actualUsd: 0.09 });
    const check = await cost.check({ missionId: 'm', providerId: 'openai', estimatedUsd: 0.05 });
    assert.equal(check.allowed, false);
    assert.match(check.reason ?? '', /presupuesto de la misión/);
  });
});

describe('cost controller: invariants', () => {
  it('refuses an unpriced call while a budget is in force, and allows it when there is none', async () => {
    const { store } = createHarness();
    const guarded = new CostController(store, budget({ perMissionUsd: 5 }));
    const refused = await guarded.check({ missionId: 'm', providerId: 'anthropic', estimatedUsd: null });
    assert.equal(refused.allowed, false);
    assert.equal(refused.action, 'block');
    assert.match(refused.reason ?? '', /Se desconoce el precio/);

    const toolOnly = new CostController(store, budget({ perToolUsd: { 'web.search': 1 } }));
    const refusedTool = await toolOnly.check({
      missionId: 'm',
      providerId: 'web.search',
      toolId: 'web.search',
      estimatedUsd: null,
    });
    assert.equal(refusedTool.allowed, false, 'a tool ceiling is a budget too');

    const free = new CostController(store, NO_BUDGET);
    const allowed = await free.check({ missionId: 'm', providerId: 'anthropic', estimatedUsd: null });
    assert.equal(allowed.allowed, true);
    assert.equal(allowed.action, 'proceed');
  });

  it('never blocks a free provider, whatever the budget says', async () => {
    const { store } = createHarness();
    const cost = new CostController(
      store,
      budget({ perMissionUsd: 0.0001, perAgentUsd: { research: 0 }, onExceed: 'block' }),
      PRICES,
    );
    await cost.record({ missionId: 'm', provider: 'openai', promptTokens: 1000, completionTokens: 1000, agentId: 'research' });
    for (const providerId of ['mock', 'ollama']) {
      const check = await cost.check({ missionId: 'm', agentId: 'research', providerId, estimatedUsd: 0 });
      assert.equal(check.allowed, true, providerId);
      assert.equal(check.action, 'proceed');
    }
  });

  it('carries the onExceed action and defaults the new budget fields', async () => {
    const { store } = createHarness();
    assert.deepEqual(NO_BUDGET.perToolUsd, {});
    assert.equal(NO_BUDGET.alertAtFraction, DEFAULT_ALERT_AT_FRACTION);

    const cost = new CostController(store, budget({ perToolUsd: { 'web.search': 0 }, onExceed: 'ask' }), PRICES);
    const check = await cost.check({ missionId: 'm', providerId: 'web.search', toolId: 'web.search', estimatedUsd: 0.01 });
    assert.equal(check.allowed, false);
    assert.equal(check.action, 'ask');

    const copy = cost.getBudget();
    copy.perToolUsd['web.search'] = 99;
    assert.equal(cost.getBudget().perToolUsd['web.search'], 0, 'getBudget returns a copy');
  });
});
