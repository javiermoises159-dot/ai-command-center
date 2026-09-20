import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { MadrePlan, MadreRunState } from '@acc/contracts';

import { STEP_LABELS, VERDICT_LABELS, activeSteps, confidenceLabel, confidenceTone, costLabel, formatUsd, orderedSteps, phaseLabel, phaseTone, planProgress, runIsLive, stepTone, verdictTone } from './madre.ts';

const plan = { steps: [{ id: 'a', title: 'A', agentId: 'strategy' }, { id: 'b', title: 'B', agentId: 'research' }, { id: 'c', title: 'C', agentId: 'qa' }] } as unknown as MadrePlan;
const step = (stepId: string, status: string, extra: object = {}) => ({ stepId, status, ...extra });
const state = (phase: string, steps: object[]) => ({ phase, steps }) as unknown as MadreRunState;

describe('madre view helpers', () => {
  it('counts settled steps as progress and done steps separately', () => {
    const p = planProgress(state('executing', [step('a', 'DONE'), step('b', 'BLOCKED'), step('c', 'QUEUED')]));
    assert.deepEqual([p.done, p.settled, p.total], [1, 2, 3]);
    assert.ok(Math.abs(p.fraction - 2 / 3) < 1e-9);
    assert.equal(planProgress(state('planning', [])).fraction, 0);
  });

  it('finds the steps working right now, in plan order', () => {
    const s = state('executing', [step('c', 'QUEUED'), step('b', 'RUNNING', { routing: { provider: { id: 'ollama', model: 'llama3' } } }), step('a', 'RETRYING')]);
    const active = activeSteps(plan, s);
    assert.deepEqual(active.map((x) => x.stepId), ['a', 'b']);
    assert.equal(active[1]?.provider, 'ollama');
    assert.deepEqual(activeSteps(null, s), []);
    assert.deepEqual(activeSteps(plan, null), []);
  });

  it('pairs plan steps with state, tolerating a missing state', () => {
    assert.equal(orderedSteps(plan, null).length, 3);
    assert.equal(orderedSteps(plan, null)[0]?.state, null);
    assert.equal(orderedSteps(plan, state('executing', [step('b', 'DONE')]))[1]?.state?.status, 'DONE');
    assert.deepEqual(orderedSteps(null, null), []);
  });

  it('polls only while the engine is working', () => {
    assert.equal(runIsLive(null), false);
    for (const phase of ['planning', 'executing', 'reviewing']) assert.equal(runIsLive(state(phase, [])), true);
    for (const phase of ['paused', 'completed', 'failed', 'cancelled']) assert.equal(runIsLive(state(phase, [])), false);
  });

  it('maps statuses to tones', () => {
    assert.equal(stepTone('DONE'), 'ok');
    assert.equal(stepTone('WAITING'), 'warn');
    assert.equal(stepTone('FAILED'), 'bad');
    assert.equal(stepTone('QUEUED'), 'neutral');
    assert.equal(verdictTone('PASS'), 'ok');
    assert.equal(verdictTone('PASS_WITH_WARNINGS'), 'warn');
    assert.equal(verdictTone('BLOCKED'), 'bad');
    assert.equal(phaseTone('paused'), 'warn');
  });

  it('labels every status, verdict and phase in Spanish', () => {
    assert.equal(STEP_LABELS.DONE, 'Hecho');
    assert.equal(STEP_LABELS.QUEUED, 'En cola');
    assert.equal(STEP_LABELS.WAITING, 'Esperándote');
    assert.equal(VERDICT_LABELS.PASS, 'Aprobado');
    assert.equal(VERDICT_LABELS.PASS_WITH_WARNINGS, 'Aprobado con avisos');
    assert.equal(VERDICT_LABELS.NEEDS_REVISION, 'Necesita revisión');
    assert.equal(phaseLabel('executing'), 'Ejecutando');
    assert.equal(phaseLabel('paused'), 'Esperándote');
  });

  it('never presents an unknown price as zero', () => {
    assert.equal(formatUsd(null), 'desconocido');
    assert.equal(formatUsd(0), '$0');
    assert.equal(formatUsd(0.0012), '$0.0012');
    assert.equal(formatUsd(1.5), '$1.50');
    const base = { calls: 3, promptTokens: 0, completionTokens: 0, knownUsd: 0.5, unpricedCalls: 2, latencyMs: 0, byProvider: {}, byAgent: {}, byTool: {} };
    assert.match(costLabel(base), /≥ \$0\.50 · 2 sin precio/);
    assert.equal(costLabel({ ...base, calls: 0 }), 'aún sin llamadas');
    assert.equal(costLabel({ ...base, unpricedCalls: 0 }), '$0.50');
  });

  it('labels confidence and treats null as not available', () => {
    assert.equal(confidenceLabel(null), 'n/d');
    assert.equal(confidenceLabel(0.074), '7%');
    assert.equal(confidenceTone(null), 'neutral');
    assert.equal(confidenceTone(0.8), 'ok');
    assert.equal(confidenceTone(0.5), 'warn');
    assert.equal(confidenceTone(0.07), 'bad');
  });
});
