/**
 * The engine and the tool pipeline together: every tool call a step asks for is
 * executed or refused with a reason, and both outcomes are visible afterwards.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { KINDS } from '../store.ts';
import type { MadreRunState, MissionPlan, ToolRequest } from '../types.ts';
import { ScriptedRunner, createEngineHarness, goodText } from '../testing.ts';
import { buildTrace } from '../observability/trace.ts';

const COOKIES = 'Quiero lanzar una tienda online de cookies en Italia.';

async function stateOf(h: ReturnType<typeof createEngineHarness>, runId: string) {
  const state = await h.store.get<MadreRunState>(KINDS.runState, runId);
  assert.ok(state);
  return state;
}

const request = (toolId: string, input: Record<string, unknown>, more: Partial<ToolRequest> = {}): ToolRequest => ({
  id: `t-${toolId}`,
  toolId,
  purpose: 'prueba',
  input,
  permission: 'READ',
  required: false,
  ...more,
});

describe('engine — tool pipeline', () => {
  it('runs the memory lookup the planner asked for, with a valid input, and puts it in the trace', async () => {
    const h = createEngineHarness();
    await h.memory.remember({ type: 'fact', title: 'cookies', content: 'Las cookies de Turín', origin: 'user' });
    const { runId, missionId } = await h.startRun(COOKIES);
    await h.engine.execute({ runId });

    const state = await stateOf(h, runId);
    const strategy = state.steps.find((s) => s.stepId === 's-strategy-positioning')!;
    const recall = strategy.toolResults?.find((r) => r.toolId === 'memory.recall');
    assert.ok(recall, 'the planned memory.recall was not executed');
    assert.equal(recall.ok, true, recall.error ?? '');

    const plan = (await h.store.get<MissionPlan>(KINDS.plan, runId))!;
    const trace = buildTrace({ missionId, runId, plan, state, audit: await h.audit.forMission(missionId) });
    const traced = trace.steps.find((s) => s.stepId === 's-strategy-positioning')!;
    assert.ok(traced.tools.some((t) => t.toolId === 'memory.recall' && t.ok));
  });

  it('accounts for every tool of the catalog: none is dropped, and each refusal has a stage, a code and a reason', async () => {
    const catalog = createEngineHarness().tools.list().map((t) => t.id);
    assert.ok(catalog.length >= 26, `expected the whole catalog, got ${catalog.length}`);
    const h = createEngineHarness({
      mutatePlan: (plan) => {
        const step = plan.steps.find((s) => s.id === 's-research-market')!;
        step.toolRequests = catalog.map((id) => request(id, {}));
      },
    });
    const { runId, missionId } = await h.startRun(COOKIES);
    await h.engine.execute({ runId });

    const state = await stateOf(h, runId);
    const step = state.steps.find((s) => s.stepId === 's-research-market')!;
    assert.equal(step.toolResults?.length, catalog.length, 'one result per request, in order');
    assert.deepEqual(step.toolResults?.map((r) => r.toolId), catalog);

    for (const result of step.toolResults ?? []) {
      if (result.ok) continue;
      assert.ok(result.stage, `${result.toolId}: a refusal must name its stage`);
      assert.ok(result.code, `${result.toolId}: a refusal must carry a code`);
      assert.ok((result.error ?? '').length > 10, `${result.toolId}: a refusal must say why`);
    }
    const refused = (await h.audit.forMission(missionId)).filter((e) => e.type === 'tool.refused' && e.stepId === 's-research-market');
    const refusedIds = (step.toolResults ?? []).filter((r) => !r.ok).map((r) => r.toolId).sort();
    assert.deepEqual(refused.map((e) => (e.data as { toolId: string }).toolId).sort(), refusedIds, 'every refusal is in the audit log');
    assert.ok(refused.length > 0);
  });

  it('shows a refused tool in the trace even when the step went on to fail', async () => {
    const h = createEngineHarness({
      runner: new ScriptedRunner((input) => {
        if (input.step.id === 's-research-market') throw new Error('400 invalid request');
        return goodText(input);
      }),
      mutatePlan: (plan) => {
        plan.steps.find((s) => s.id === 's-research-market')!.toolRequests = [request('web.search', { query: 'galletas' })];
      },
    });
    const { runId, missionId } = await h.startRun(COOKIES);
    await h.engine.execute({ runId });

    const state = await stateOf(h, runId);
    const step = state.steps.find((s) => s.stepId === 's-research-market')!;
    assert.equal(step.status, 'FAILED');
    assert.equal(step.result, null);
    const plan = (await h.store.get<MissionPlan>(KINDS.plan, runId))!;
    const traced = buildTrace({ missionId, runId, plan, state, audit: await h.audit.forMission(missionId) }).steps.find((s) => s.stepId === 's-research-market')!;
    assert.equal(traced.tools.length, 1);
    assert.equal(traced.tools[0]!.ok, false);
    assert.equal(traced.tools[0]!.code, 'tool_unavailable');
    assert.equal(traced.tools[0]!.stage, 'availability');
  });

  it('tells the agent which tool it could not have and why, so it does not invent the output', async () => {
    const h = createEngineHarness({
      mutatePlan: (plan) => {
        plan.steps.find((s) => s.id === 's-research-market')!.toolRequests = [request('web.search', { query: 'galletas' })];
      },
    });
    const { runId } = await h.startRun(COOKIES);
    await h.engine.execute({ runId });

    const runner = h.runner as ScriptedRunner;
    const call = runner.callsFor('s-research-market')[0]!;
    const failure = call.toolResults.find((r) => r.toolId === 'web.search');
    assert.ok(failure && !failure.ok);
    assert.equal(failure.code, 'tool_unavailable');
    assert.match(failure.error ?? '', /NOT_CONNECTED/);
    assert.ok(call.caveats.some((c) => /fuentes en vivo/.test(c)), 'a live-source tool that failed leaves the live-source caveat');
  });

  it('refuses a disabled tool at execution time and carries on without it', async () => {
    const h = createEngineHarness();
    h.tools.disable('memory.recall', 'Apagada por el operador');
    const { runId } = await h.startRun(COOKIES);
    const outcome = await h.engine.execute({ runId });
    assert.equal(outcome.status, 'completed');

    const state = await stateOf(h, runId);
    const results = state.steps.flatMap((s) => s.toolResults ?? []).filter((r) => r.toolId === 'memory.recall');
    assert.ok(results.length > 0);
    assert.ok(results.every((r) => !r.ok && r.code === 'tool_disabled' && /Apagada por el operador/.test(r.error ?? '')));
  });

  it('blocks a step whose required tool cannot be used, and never asks the model to improvise it', async () => {
    const h = createEngineHarness({
      mutatePlan: (plan) => {
        // The router would block this up front; the point is that the engine is safe on its own.
        plan.steps.find((s) => s.id === 's-design-brand')!.toolRequests = [request('memory.recall', {}, { required: true })];
      },
    });
    const { runId } = await h.startRun(COOKIES);
    const outcome = await h.engine.execute({ runId });
    const state = await stateOf(h, runId);
    const step = state.steps.find((s) => s.stepId === 's-design-brand')!;
    assert.equal(step.status, 'BLOCKED');
    assert.match(step.blockedReason ?? '', /obligatoria «memory\.recall»/);
    assert.match(step.blockedReason ?? '', /Falta el campo obligatorio «query»/);
    assert.equal((h.runner as ScriptedRunner).callsFor('s-design-brand').length, 0, 'the model must not be called');
    assert.notEqual(outcome.status, 'paused');
  });

  it('refuses a call the permission policy blocks, even if the plan slipped it in', async () => {
    const h = createEngineHarness({
      mutatePlan: (plan) => {
        plan.steps.find((s) => s.id === 's-research-market')!.toolRequests = [request('memory.recall', { query: 'x' }, { permission: 'FINANCIAL' })];
      },
    });
    const { runId } = await h.startRun(COOKIES);
    await h.engine.execute({ runId });
    const state = await stateOf(h, runId);
    const result = state.steps.find((s) => s.stepId === 's-research-market')!.toolResults?.[0];
    assert.ok(result && !result.ok);
    assert.ok(['permission_denied', 'approval_required'].includes(result.code ?? ''), String(result.code));
    assert.equal(result.stage, 'permission');
  });

  it('records a tool call in the cost ledger under its own id, and refuses it under a budget when its price is unknown', async () => {
    const budget = { perMissionUsd: 10, dailyUsd: null, monthlyUsd: null, perAgentUsd: {}, perToolUsd: {}, alertAtFraction: 0.8, onExceed: 'block' as const };
    const h = createEngineHarness({ budget });
    // Make memory.recall look like a paid tool with no known price.
    h.tools.require('memory.recall').cost = { model: 'per_call', note: 'sin precio' };
    const { runId } = await h.startRun(COOKIES);
    await h.engine.execute({ runId });

    const state = await stateOf(h, runId);
    const results = state.steps.flatMap((s) => s.toolResults ?? []).filter((r) => r.toolId === 'memory.recall');
    assert.ok(results.length > 0);
    assert.ok(results.every((r) => !r.ok && r.stage === 'cost' && r.code === 'cost_blocked'), JSON.stringify(results.map((r) => [r.code, r.error])));
    assert.equal((await h.cost.summary({ runId })).byTool['memory.recall'], undefined, 'a refused call is not billed');
  });
});
