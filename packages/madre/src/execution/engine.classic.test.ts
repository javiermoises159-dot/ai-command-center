/**
 * The classic pipeline on the MADRE engine.
 *
 * Classic used to run in its own orchestrator, outside routing, permissions,
 * cost limits, the audit log, the trace and cancellation. These tests hold it
 * to the same controls as any other mission — and show it cannot skip one,
 * because there is no second code path that could.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildTrace } from '../observability/trace.ts';
import { KINDS } from '../store.ts';
import type { MadreRunState, MissionPlan } from '../types.ts';
import { ANTHROPIC, MOCK, OLLAMA_MIXED, ScriptedRunner, createEngineHarness, goodText } from '../testing.ts';
import { ClassicPlanner } from '../compiler/classic.ts';
import { RunRecovery } from './recovery.ts';

const PROMPT = 'Launch an online cookie store in Italy';
const ORDER = ['strategy', 'research', 'code', 'design', 'marketing', 'finance', 'qa', 'integrator'];

const stateOf = async (h: ReturnType<typeof createEngineHarness>, runId: string) => (await h.store.get<MadreRunState>(KINDS.runState, runId))!;

describe('classic — the plan', () => {
  it('lays out the eight catalog agents in order, each seeing everything before it, one attempt each, no tools', () => {
    const h = createEngineHarness();
    const plan = new ClassicPlanner(h.agents).plan(PROMPT);
    assert.equal(plan.planner, 'classic-planner@1');
    assert.equal(plan.steps.length, 8);
    assert.deepEqual(plan.steps.map((s) => h.agents.get(s.agentId)?.legacyAgentId), ORDER);
    assert.deepEqual(plan.steps.map((s) => s.kind), ['agent', 'agent', 'agent', 'agent', 'agent', 'agent', 'qa', 'integrate']);
    for (const step of plan.steps) {
      assert.equal(step.maxAttempts, 1);
      assert.deepEqual(step.toolRequests, []);
    }
    assert.equal(plan.steps[5]!.dependsOn.length, 5, 'finance sees all five specialists before it');
    assert.equal(plan.steps[7]!.dependsOn.find((d) => d.stepId === 's-qa')?.mode, 'hard');
    assert.deepEqual(plan.parallelGroups.map((g) => g.length), [1, 1, 1, 1, 1, 1, 1, 1], 'strictly sequential');
  });

  it('with continueOnWorkerFailure=false every link is hard, so a failure stops the rest', () => {
    const h = createEngineHarness();
    const plan = new ClassicPlanner(h.agents, { continueOnWorkerFailure: false }).plan(PROMPT);
    assert.ok(plan.steps.flatMap((s) => s.dependsOn).every((d) => d.mode === 'hard'));
  });
});

describe('classic — on the engine, with every control', () => {
  it('runs all eight agents, each routed, audited, traced and mirrored to its legacy row', async () => {
    const h = createEngineHarness({ descriptors: [MOCK] });
    const { runId, missionId } = await h.startRun(PROMPT);
    const outcome = await h.engine.execute({ runId, mode: 'classic' });
    assert.equal(outcome.status, 'completed');

    const state = await stateOf(h, runId);
    assert.equal(state.mode, 'classic');
    assert.ok(state.steps.every((s) => s.status === 'DONE'));
    assert.equal((h.runner as ScriptedRunner).calls.length, 8, 'one call per agent: no retries, no revision rounds');

    const events = await h.audit.forMission(missionId);
    assert.equal(events.filter((e) => e.type === 'route.decided').length, 8, 'routing decided every step');
    assert.ok(events.some((e) => e.type === 'plan.created' && (e.data as { mode: string }).mode === 'classic'));
    assert.ok(events.some((e) => e.type === 'run.completed'));

    const rows = await h.repos.agents.listByRun(runId);
    assert.equal(rows.length, 8);
    assert.ok(rows.every((r) => r.status === 'completed'));
    assert.equal((await h.repos.missions.findById(missionId))!.status, 'completed');

    const plan = (await h.store.get<MissionPlan>(KINDS.plan, runId))!;
    const trace = buildTrace({ missionId, runId, plan, state, audit: events });
    assert.equal(trace.mode, 'classic');
    assert.equal(trace.steps.length, 8);
    assert.ok(trace.steps.every((s) => s.provider === 'mock'));
    assert.equal((await stateOf(h, runId)).cost.calls, 8, 'the cost ledger saw every call');
  });

  it('stays on the provider the mission was started with, even when the router would prefer another', async () => {
    const h = createEngineHarness({ descriptors: [OLLAMA_MIXED, MOCK] });
    const { runId } = await h.startRun(PROMPT, { providerId: 'mock', model: 'mock-1' });
    await h.engine.execute({ runId, mode: 'classic' });
    const calls = (h.runner as ScriptedRunner).calls;
    assert.equal(calls.length, 8);
    assert.ok(calls.every((c) => c.provider.id === 'mock'), 'a pin narrows the choice');

    // The same mission as a MADRE mission is free to prefer the real provider.
    const other = await h.startRun(PROMPT, { providerId: 'mock', model: 'mock-1' });
    await h.engine.execute({ runId: other.runId, mode: 'madre' });
    assert.ok((h.runner as ScriptedRunner).calls.slice(8).some((c) => c.provider.id === 'ollama'));
  });

  it('blocks — and does not reroute — when the pinned provider is not available', async () => {
    const h = createEngineHarness({ descriptors: [OLLAMA_MIXED] });
    const { runId } = await h.startRun(PROMPT, { providerId: 'mock', model: 'mock-1' });
    const outcome = await h.engine.execute({ runId, mode: 'classic' });
    assert.equal(outcome.status, 'failed');
    assert.equal((h.runner as ScriptedRunner).calls.length, 0, 'nothing was sent to another provider');
    const state = await stateOf(h, runId);
    assert.ok(state.steps.every((s) => s.status === 'BLOCKED'));
    assert.match(state.steps[0]!.blockedReason ?? '', /«mock».*ninguno|«mock»/);
  });

  it('is held to the cost limits: a paid provider with no known price under a budget is refused', async () => {
    const budget = { perMissionUsd: 1, dailyUsd: null, monthlyUsd: null, perAgentUsd: {}, perToolUsd: {}, alertAtFraction: 0.8, onExceed: 'block' as const };
    const h = createEngineHarness({ descriptors: [ANTHROPIC], budget });
    const { runId } = await h.startRun(PROMPT, { providerId: 'anthropic', model: 'big' });
    const outcome = await h.engine.execute({ runId, mode: 'classic' });
    assert.equal(outcome.status, 'failed');
    assert.equal((h.runner as ScriptedRunner).calls.length, 0, 'the model was never called');
    const state = await stateOf(h, runId);
    assert.ok(state.steps.some((s) => s.status === 'BLOCKED' && /presupuesto|precio|coste/i.test(s.blockedReason ?? '')), JSON.stringify(state.steps.map((s) => s.blockedReason)));
  });

  it('feeds the circuit breaker: repeated provider failures open it and the rest of the pipeline is blocked, not retried', async () => {
    const h = createEngineHarness({
      descriptors: [MOCK],
      runner: new ScriptedRunner(() => {
        throw new Error('503 service unavailable');
      }),
    });
    const { runId, missionId } = await h.startRun(PROMPT);
    const outcome = await h.engine.execute({ runId, mode: 'classic' });
    assert.equal(outcome.status, 'failed');
    const calls = (h.runner as ScriptedRunner).calls.length;
    assert.equal(calls, 3, `three failures open the breaker, then nothing more is attempted (saw ${calls})`);
    assert.ok((await h.audit.forMission(missionId)).some((e) => e.type === 'provider.circuit_opened'));
    assert.equal(h.router.circuitState('mock')?.open, true);
  });

  it('a failed specialist does not stop the others, and the brief says what is missing', async () => {
    const h = createEngineHarness({
      descriptors: [MOCK],
      runner: new ScriptedRunner((input) => {
        if (input.step.id === 's-classic-design') throw new Error('400 bad request');
        return goodText(input);
      }),
    });
    const { runId, missionId } = await h.startRun(PROMPT);
    const outcome = await h.engine.execute({ runId, mode: 'classic' });
    assert.equal(outcome.status, 'failed', 'a run is completed only when every agent completed');
    assert.ok(outcome.finalResult !== null, 'the partial brief is kept');
    const state = await stateOf(h, runId);
    assert.equal(state.steps.find((s) => s.stepId === 's-classic-design')!.status, 'FAILED');
    assert.equal(state.steps.find((s) => s.stepId === 's-integrate')!.status, 'DONE');
    const rows = await h.repos.agents.listByRun(runId);
    assert.equal(rows.filter((r) => r.status === 'failed').length, 1);
    assert.equal((await h.repos.missions.findById(missionId))!.status, 'failed');
  });

  it('a QA failure ends the run: the integrator is blocked, not run', async () => {
    const h = createEngineHarness({
      descriptors: [MOCK],
      runner: new ScriptedRunner((input) => {
        if (input.step.id === 's-qa') throw new Error('400 bad request');
        return goodText(input);
      }),
    });
    const { runId } = await h.startRun(PROMPT);
    const outcome = await h.engine.execute({ runId, mode: 'classic' });
    assert.equal(outcome.status, 'failed');
    assert.equal(outcome.finalResult, null);
    assert.equal((await stateOf(h, runId)).steps.find((s) => s.stepId === 's-integrate')!.status, 'BLOCKED');
  });
});

describe('classic — cancellation and recovery', () => {
  it('cancels a run that is executing: returns true, aborts the agent in flight, leaves nothing running', async () => {
    const h = createEngineHarness({
      descriptors: [MOCK],
      runner: new ScriptedRunner(
        (input, signal) =>
          input.step.id === 's-classic-research'
            ? new Promise<string>((_, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted'))))
            : goodText(input),
      ),
    });
    const { runId, missionId } = await h.startRun(PROMPT);
    const running = h.engine.execute({ runId, mode: 'classic' });
    for (let i = 0; i < 400 && (h.runner as ScriptedRunner).callsFor('s-classic-research').length === 0; i++) await new Promise((r) => setTimeout(r, 5));

    assert.equal(await h.engine.cancel(runId), true, 'cancelling a classic run must not return false');
    const outcome = await running;
    assert.equal(outcome.status, 'cancelled');

    const state = await stateOf(h, runId);
    assert.equal(state.phase, 'cancelled');
    assert.equal(state.steps.filter((s) => ['RUNNING', 'RETRYING', 'QUEUED', 'WAITING'].includes(s.status)).length, 0);
    assert.equal(state.steps.find((s) => s.stepId === 's-classic-strategy')!.status, 'DONE', 'finished work is kept');
    assert.equal((await h.repos.runs.findById(runId))!.status, 'failed');
    assert.ok((await h.audit.forMission(missionId)).some((e) => e.type === 'run.cancel_requested'));
    assert.equal(await h.engine.cancel(runId), false, 'a second cancel has nothing to cancel');
  });

  it('cancels a classic run that is still waiting in the queue, and the late job does not run it', async () => {
    const h = createEngineHarness({ descriptors: [MOCK] });
    const { runId, missionId } = await h.startRun(PROMPT);
    assert.equal(await h.engine.cancel(runId), true);
    assert.equal((await h.repos.runs.findById(runId))!.status, 'failed');
    assert.equal((await h.repos.missions.findById(missionId))!.status, 'failed');
    assert.ok((await h.repos.agents.listByRun(runId)).every((a) => a.status === 'skipped'));

    const late = await h.engine.execute({ runId, mode: 'classic' });
    assert.equal(late.status, 'failed');
    assert.equal((h.runner as ScriptedRunner).calls.length, 0, 'the closed run was not executed');
  });

  it('recovers a classic run killed mid-flight, exactly like any other', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const h = createEngineHarness({
      descriptors: [MOCK],
      runner: new ScriptedRunner(async (input) => {
        calls += 1;
        if (calls > 2) await gate;
        return goodText(input);
      }),
    });
    const { runId, missionId } = await h.startRun(PROMPT);
    const dead = h.engine.execute({ runId, mode: 'classic' }).catch(() => undefined);
    for (let i = 0; i < 400; i++) {
      const s = await h.store.get<MadreRunState>(KINDS.runState, runId);
      if (s?.steps.some((x) => x.status === 'RUNNING')) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    const recovery = new RunRecovery({ repositories: h.repos, store: h.store, audit: h.audit, approvals: h.approvals, cost: h.cost, agents: h.agents, clock: h.clock });
    const report = await recovery.recover();
    assert.equal(report.recovered[0]?.outcome, 'interrupted');
    assert.deepEqual(await recovery.inspect(missionId), []);
    const state = await stateOf(h, runId);
    assert.equal(state.mode, 'classic');
    assert.equal(state.steps.filter((s) => s.status === 'RUNNING').length, 0);
    release();
    await dead;
  });
});
