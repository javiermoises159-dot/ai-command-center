/**
 * Failures that used to disappear. Each of these was answered with a quiet
 * `false`, `null` or empty catch; each now surfaces where a person can see it.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { KINDS } from '../store.ts';
import type { MadreRunState } from '../types.ts';
import { ScriptedRunner, createEngineHarness, goodText } from '../testing.ts';

const PROMPT = 'Quiero lanzar una tienda online de cookies en Italia.';

describe('engine — failures are not swallowed', () => {
  it('cancel does not answer "false" when the run exists but cannot be read', async () => {
    const h = createEngineHarness({
      mutatePlan: (plan) => {
        plan.steps.find((s) => s.id === 's-design-brand')!.toolRequests.push({ id: 'ask', toolId: 'math.calculator', purpose: 'x', input: {}, permission: 'DELETE', required: false });
      },
    });
    const { runId } = await h.startRun(PROMPT);
    assert.equal((await h.engine.execute({ runId })).status, 'paused');

    const original = h.store.get.bind(h.store);
    (h.store as { get: unknown }).get = async (kind: string, id: string) => {
      if (kind === KINDS.plan) throw new Error('base de datos no disponible');
      return original(kind as never, id);
    };
    await assert.rejects(() => h.engine.cancel(runId), /base de datos no disponible/, 'a read failure is an error, not "nothing to cancel"');
    (h.store as { get: unknown }).get = original;
    assert.equal(await h.engine.cancel(runId), true, 'and once it can be read the run really is cancelled');
  });

  it('cancel of a run that does not exist is false, not an error', async () => {
    const h = createEngineHarness();
    assert.equal(await h.engine.cancel('no-existe'), false);
  });

  it('a state that cannot be persisted stops the run and says so, instead of carrying on unrecorded', async () => {
    const h = createEngineHarness();
    const { runId, missionId } = await h.startRun(PROMPT);
    const put = h.store.put.bind(h.store);
    let runStateWrites = 0;
    (h.store as { put: unknown }).put = async (kind: string, id: string, payload: unknown, meta: unknown) => {
      if (kind === KINDS.runState && ++runStateWrites > 3) throw new Error('disco lleno');
      return put(kind as never, id, payload as never, meta as never);
    };
    const outcome = await h.engine.execute({ runId });
    assert.equal(outcome.status, 'failed');
    const aborted = (await h.audit.forMission(missionId)).find((e) => e.type === 'run.aborted');
    assert.ok(aborted, 'the abort is in the audit log');
    assert.match(aborted!.message, /No se pudo guardar el estado.*disco lleno/);
    assert.equal((await h.repos.runs.findById(runId))!.status, 'failed', 'the legacy run is closed, not left running');
  });

  it('a memory write that fails is reported in the audit log', async () => {
    const h = createEngineHarness();
    h.memory.remember = async () => {
      throw new Error('memoria llena');
    };
    const { runId, missionId } = await h.startRun(PROMPT);
    const outcome = await h.engine.execute({ runId });
    assert.equal(outcome.status, 'completed', 'memory is best-effort: the mission still completes');
    const event = (await h.audit.forMission(missionId)).find((e) => e.type === 'memory.write_failed');
    assert.ok(event);
    assert.match(event!.message, /memoria llena/);
  });

  it('a mirror that cannot write to the legacy rows fails the run visibly', async () => {
    const h = createEngineHarness({ runner: new ScriptedRunner(goodText) });
    const { runId, missionId } = await h.startRun(PROMPT);
    const original = h.repos.agents.markCompleted.bind(h.repos.agents);
    h.repos.agents.markCompleted = async () => {
      throw new Error('fila bloqueada');
    };
    const outcome = await h.engine.execute({ runId });
    assert.equal(outcome.status, 'failed');
    assert.ok((await h.audit.forMission(missionId)).some((e) => e.type === 'run.aborted' && /fila bloqueada/.test(e.message)));
    h.repos.agents.markCompleted = original;
    const state = (await h.store.get<MadreRunState>(KINDS.runState, runId))!;
    assert.equal(state.steps.filter((s) => s.status === 'RUNNING').length, 0, 'no step is left RUNNING');
  });
});
