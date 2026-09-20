/**
 * Boot-time recovery. The scenario is the real one: a run is mid-flight, two
 * steps are RUNNING, the process dies, and a new process starts over the same
 * database. Whatever it finds, the mission, the run, the agent rows, the steps,
 * the trace and the API must tell the same story afterwards.
 *
 * The "process" that dies is an engine whose runner never answers: its steps
 * stay RUNNING in the persisted state exactly as they would after a kill -9.
 * A second, fresh recovery object over the same repositories is the restart.
 */

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { buildTrace } from '../observability/trace.ts';
import { KINDS } from '../store.ts';
import { ScriptedRunner, createEngineHarness, goodText } from '../testing.ts';
import type { MadreRunState, MissionPlan } from '../types.ts';
import { RunRecovery } from './recovery.ts';

const COOKIES = 'Quiero lanzar una tienda online de cookies en Italia.';

type Harness = ReturnType<typeof createEngineHarness>;

function restartOf(h: Harness): RunRecovery {
  // A brand-new object over the same persisted data: nothing of the old process survives.
  return new RunRecovery({
    repositories: h.repos,
    store: h.store,
    audit: h.audit,
    approvals: h.approvals,
    cost: h.cost,
    agents: h.agents,
    clock: h.clock,
  });
}

const stateOf = async (h: Harness, runId: string) => (await h.store.get<MadreRunState>(KINDS.runState, runId))!;

/** Wait until the persisted state shows at least `n` steps RUNNING. */
async function untilRunning(h: Harness, runId: string, n: number): Promise<MadreRunState> {
  for (let i = 0; i < 400; i++) {
    const state = await h.store.get<MadreRunState>(KINDS.runState, runId);
    if (state !== null && state.steps.filter((s) => s.status === 'RUNNING').length >= n) return state;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('the run never reached the expected state');
}

const zombies: { release: () => void; done: Promise<unknown> }[] = [];

/**
 * A mission that has finished two steps and has two more RUNNING, whose
 * process is gone: the first two runner calls answer, every later one hangs.
 */
async function midFlight() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const h = createEngineHarness({
    runner: new ScriptedRunner(async (input) => {
      calls += 1;
      if (calls > 2) await gate;
      return goodText(input);
    }),
  });
  const { runId, missionId } = await h.startRun(COOKIES);
  const done = h.engine.execute({ runId }).catch(() => undefined);
  zombies.push({ release, done });
  const before = await untilRunning(h, runId, 2);
  return { h, runId, missionId, before };
}

/** What the OLD boot sweep did: closed only the legacy rows and left the state alone. */
async function oldSweep(h: Harness, runId: string, missionId: string) {
  const at = h.clock.now();
  for (const agent of await h.repos.agents.listByRun(runId)) {
    if (agent.status === 'running') await h.repos.agents.markFailed(agent.id, 'El servidor se reinició.', at);
  }
  await h.repos.agents.markRemainingSkipped(runId, at);
  await h.repos.runs.markFinished(runId, 'failed', at, { error: 'El servidor se reinició.' });
  await h.repos.missions.updateStatus(missionId, 'failed', at);
}

after(async () => {
  // Let the dead engines finish so the test process can exit.
  for (const z of zombies) z.release();
  await Promise.all(zombies.map((z) => z.done));
});

describe('recovery — a process killed mid-run', () => {
  it('is a real mid-flight state before recovery: two steps RUNNING, legacy rows running', async () => {
    const { h, runId, missionId, before } = await midFlight();
    assert.ok(before.steps.filter((s) => s.status === 'RUNNING').length >= 2);
    assert.equal((await h.repos.runs.findById(runId))!.status, 'running');
    assert.equal((await h.repos.missions.findById(missionId))!.status, 'running');
    assert.deepEqual(await restartOf(h).inspect(missionId), [], 'a run that is really executing is consistent');
  });

  it('REGRESSION: mission FAILED while a step is RUNNING is detected, and recovery removes it', async () => {
    const { h, runId, missionId } = await midFlight();
    await oldSweep(h, runId, missionId);

    const recovery = restartOf(h);
    const broken = await recovery.inspect(missionId);
    assert.ok(broken.length > 0, 'the contradiction must be detectable');
    assert.ok(broken.some((p) => /misión está «failed» pero el paso .* sigue «RUNNING»/.test(p)), broken.join('\n'));
    assert.ok(broken.some((p) => /estado guardado dice «executing»/.test(p)));

    await recovery.recover();

    assert.deepEqual(await recovery.inspect(missionId), [], 'after recovery nothing contradicts');
    const state = await stateOf(h, runId);
    assert.equal(state.steps.filter((s) => s.status === 'RUNNING' || s.status === 'RETRYING').length, 0, 'no step stays RUNNING');
    assert.equal((await h.repos.missions.findById(missionId))!.status, 'failed');
  });

  it('closes an interrupted run: RUNNING steps fail as interrupted, finished steps keep their result, queued steps are blocked', async () => {
    const { h, runId, missionId, before } = await midFlight();
    const finishedBefore = before.steps.filter((s) => s.status === 'DONE');
    const runningBefore = before.steps.filter((s) => s.status === 'RUNNING').map((s) => s.stepId);
    assert.ok(finishedBefore.length >= 1);

    const report = await restartOf(h).recover();
    assert.equal(report.recovered.length, 1);
    assert.equal(report.recovered[0]!.outcome, 'interrupted');
    assert.equal(report.recovered[0]!.retryable, true);

    const state = await stateOf(h, runId);
    assert.equal(state.phase, 'failed');
    assert.ok(state.completedAt);
    for (const id of runningBefore) {
      const st = state.steps.find((s) => s.stepId === id)!;
      assert.equal(st.status, 'FAILED');
      assert.equal(st.interrupted, true);
      assert.match(st.error ?? '', /reinició/);
      assert.equal(st.result, null, 'no result is invented for a step that never answered');
    }
    for (const done of finishedBefore) {
      const st = state.steps.find((s) => s.stepId === done.stepId)!;
      assert.equal(st.status, 'DONE');
      assert.deepEqual(st.result, done.result, 'finished work is left exactly as it was');
    }
    const queued = state.steps.filter((s) => s.blockedReason?.includes('interrumpió'));
    assert.ok(queued.length > 0);
    assert.ok(queued.every((s) => s.status === 'BLOCKED'));

    // Never invent success: no final result, mission failed, run failed.
    const run = await h.repos.runs.findById(runId);
    assert.equal(run!.status, 'failed');
    assert.equal((await h.repos.missions.findById(missionId))!.status, 'failed');
    assert.equal((await h.repos.missions.findById(missionId))!.finalResult, null);
    assert.equal(state.recovery?.outcome, 'interrupted');
    assert.ok((state.recovery?.steps.length ?? 0) > 0, 'what was changed is recorded');
  });

  it('brings the agent rows in line: none is left running, the finished agent keeps its result', async () => {
    const { h, runId } = await midFlight();
    await restartOf(h).recover();
    const rows = await h.repos.agents.listByRun(runId);
    assert.equal(rows.filter((r) => r.status === 'running' || r.status === 'pending').length, 0);
    assert.ok(rows.some((r) => r.status === 'completed'), 'an agent whose steps all finished stays completed');
    assert.ok(rows.some((r) => r.status === 'failed'));
  });

  it('is idempotent: a second pass changes nothing and adds no event', async () => {
    const { h, runId, missionId } = await midFlight();
    const recovery = restartOf(h);
    const first = await recovery.recover();
    assert.equal(first.recovered.length, 1);
    const snapshot = JSON.stringify(await stateOf(h, runId));
    const events = (await h.audit.forMission(missionId)).length;

    const second = await restartOf(h).recover();
    assert.equal(second.recovered.length, 0);
    assert.equal(second.scanned, 0, 'nothing is left to look at');
    assert.equal(JSON.stringify(await stateOf(h, runId)), snapshot);
    assert.equal((await h.audit.forMission(missionId)).length, events);
    assert.equal((await h.audit.forMission(missionId)).filter((e) => e.type === 'run.recovered').length, 1);
  });

  it('finishes a first pass that was cut short after the state was written but before the legacy rows were closed', async () => {
    const { h, runId, missionId } = await midFlight();
    const state = await stateOf(h, runId);
    for (const st of state.steps) if (st.status === 'RUNNING') st.status = 'FAILED';
    state.phase = 'failed';
    state.recovery = { at: state.updatedAt, outcome: 'interrupted', retryable: true, reason: 'interrumpida', steps: [] };
    await h.store.put(KINDS.runState, runId, state, { missionId, runId });
    assert.equal((await h.repos.runs.findById(runId))!.status, 'running');
    assert.ok((await restartOf(h).inspect(missionId)).length > 0);

    const report = await restartOf(h).recover();
    assert.equal(report.recovered.length, 1);
    assert.equal((await h.repos.runs.findById(runId))!.status, 'failed');
    assert.equal((await h.repos.missions.findById(missionId))!.status, 'failed');
    assert.deepEqual(await restartOf(h).inspect(missionId), []);
    assert.equal((await restartOf(h).recover()).recovered.length, 0);
  });

  it('shows the same logical state in the trace and the snapshot the API serves', async () => {
    const { h, runId, missionId } = await midFlight();
    await oldSweep(h, runId, missionId);
    await restartOf(h).recover();

    const state = await stateOf(h, runId);
    const plan = (await h.store.get<MissionPlan>(KINDS.plan, runId))!;
    const trace = buildTrace({ missionId, runId, plan, state, audit: await h.audit.forMission(missionId) });
    assert.equal(trace.recovery?.outcome, 'interrupted');
    assert.equal(trace.steps.filter((s) => s.status === 'RUNNING' || s.status === 'RETRYING').length, 0);
    const interrupted = trace.steps.filter((s) => s.status === 'FAILED');
    assert.ok(interrupted.length >= 2);
    assert.ok(interrupted.every((s) => /reinició/.test(s.error ?? '')));
    assert.ok((await h.audit.forMission(missionId)).some((e) => e.type === 'run.recovered' && /Recuperada/.test(e.message)), 'what was recovered, and why, is in the audit log');
  });

  it('denies a pending approval of a run it closes, so the inbox never points at a dead run', async () => {
    const { h, runId, missionId } = await midFlight();
    await h.approvals.request({ missionId, runId, stepId: null, kind: 'permission', level: 'PUBLISH', title: 'Publicar', detail: 'x' });
    await restartOf(h).recover();
    assert.equal((await h.approvals.pending()).length, 0);
    assert.equal((await h.approvals.forRun(runId))[0]!.status, 'denied');
  });

  it('leaves a run paused for a person alone, and reports one whose approvals are decided as resumable', async () => {
    const h = createEngineHarness({
      mutatePlan: (plan) => {
        plan.steps
          .find((s) => s.id === 's-design-brand')!
          .toolRequests.push({ id: 'ask', toolId: 'math.calculator', purpose: 'Delete stale files', input: {}, permission: 'DELETE', required: false });
      },
    });
    const { runId, missionId } = await h.startRun(COOKIES);
    assert.equal((await h.engine.execute({ runId })).status, 'paused');

    const kept = await restartOf(h).recover();
    assert.deepEqual(kept.kept, [runId]);
    assert.equal(kept.recovered.length, 0);
    assert.deepEqual(await restartOf(h).inspect(missionId), [], 'a paused run is consistent, not a casualty');
    assert.equal((await stateOf(h, runId)).phase, 'paused');

    // Decided while the server was down: nobody is left to continue it.
    for (const a of await h.approvals.pending()) await h.approvals.decide(a.id, 'approved');
    const resumable = await restartOf(h).recover();
    assert.deepEqual(resumable.resumable.map((r) => r.runId), [runId]);

    // And it really does continue from the persisted state.
    const outcome = await h.newEngine().execute({ runId, resume: true });
    assert.equal(outcome.status, 'completed');
    assert.deepEqual(await restartOf(h).inspect(missionId), []);
  });

  it('closes a run that never saved a plan, with the legacy rows only', async () => {
    const h = createEngineHarness();
    const { runId, missionId } = await h.startRun(COOKIES);
    await h.repos.runs.markStarted(runId, h.clock.now());
    await h.repos.missions.updateStatus(missionId, 'running', h.clock.now());
    const report = await restartOf(h).recover();
    assert.equal(report.recovered.length, 1);
    assert.equal((await h.repos.runs.findById(runId))!.status, 'failed');
    assert.equal((await h.repos.missions.findById(missionId))!.status, 'failed');
    assert.deepEqual(await restartOf(h).inspect(missionId), []);
  });

  it('points a mission that says running, with no live run behind it, at what its newest run says', async () => {
    const h = createEngineHarness();
    const { runId, missionId } = await h.startRun(COOKIES);
    await h.engine.execute({ runId });
    assert.equal((await h.repos.missions.findById(missionId))!.status, 'completed');
    await h.repos.missions.updateStatus(missionId, 'running', h.clock.now());
    assert.ok((await restartOf(h).inspect(missionId)).length > 0);
    const report = await restartOf(h).recover();
    assert.deepEqual(report.missionsReconciled, [missionId]);
    assert.equal((await h.repos.missions.findById(missionId))!.status, 'completed');
    assert.deepEqual(await restartOf(h).inspect(missionId), []);
  });

  it('does not touch a healthy completed run', async () => {
    const h = createEngineHarness();
    const { runId, missionId } = await h.startRun(COOKIES);
    await h.engine.execute({ runId });
    const before = JSON.stringify(await stateOf(h, runId));
    const report = await restartOf(h).recover();
    assert.equal(report.scanned, 0);
    assert.equal(JSON.stringify(await stateOf(h, runId)), before);
    assert.deepEqual(await restartOf(h).inspect(missionId), []);
  });

  it('the engine refuses a stale job for a run the database already closed', async () => {
    const { h, runId, missionId } = await midFlight();
    await oldSweep(h, runId, missionId);
    // A different engine than the one still "running" it: a job arriving after the restart.
    const outcome = await h.newEngine().execute({ runId });
    assert.equal(outcome.status, 'failed');
    assert.ok((await h.audit.forMission(missionId)).some((e) => e.type === 'run.refused'));
    assert.equal((await h.repos.runs.findById(runId))!.status, 'failed', 'the closed run stays closed');
  });
});
