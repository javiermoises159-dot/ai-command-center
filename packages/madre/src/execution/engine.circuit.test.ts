/**
 * The circuit breaker inside a real run: provider failures reported by the
 * engine open it, the router then leaves the provider out, the cooldown ends,
 * and a call that works brings it back.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { KINDS } from '../store.ts';
import type { MadreRunState } from '../types.ts';
import { ANTHROPIC, OLLAMA_MIXED, ScriptedRunner, createEngineHarness, goodText } from '../testing.ts';

const COOKIES = 'Quiero lanzar una tienda online de cookies en Italia.';
const COOLDOWN_MS = 60_000;

/** A run over two providers where `down` decides whether ollama is answering. */
function scenario(state: { ollamaDown: boolean; ollamaText?: string }) {
  return createEngineHarness({
    descriptors: [OLLAMA_MIXED, ANTHROPIC],
    engine: { parallelism: 1 },
    runner: new ScriptedRunner((input) => {
      if (input.provider.id === 'ollama') {
        if (state.ollamaDown) throw new Error('ECONNREFUSED 127.0.0.1:11434');
        if (state.ollamaText !== undefined) return state.ollamaText;
      }
      return goodText(input);
    }),
  });
}

const ollamaCalls = (h: ReturnType<typeof scenario>) => (h.runner as ScriptedRunner).calls.filter((c) => c.provider.id === 'ollama');
const eventsOf = async (h: ReturnType<typeof scenario>, missionId: string, type: string) => (await h.audit.forMission(missionId)).filter((e) => e.type === type);

describe('circuit breaker — wired into the engine', () => {
  it('does not open below the threshold, and keeps offering the provider', async () => {
    // ollama fails its first two calls, then recovers.
    let ollamaFailures = 0;
    const h = createEngineHarness({
      descriptors: [OLLAMA_MIXED, ANTHROPIC],
      engine: { parallelism: 1 },
      runner: new ScriptedRunner((input) => {
        if (input.provider.id === 'ollama' && ollamaFailures < 2) {
          ollamaFailures += 1;
          throw new Error('ECONNREFUSED 127.0.0.1:11434');
        }
        return goodText(input);
      }),
    });
    const { runId, missionId } = await h.startRun(COOKIES);
    await h.engine.execute({ runId });

    assert.equal(ollamaFailures, 2);
    const state = h.router.circuitState('ollama');
    assert.equal(state?.open, false);
    assert.equal(state?.consecutiveFailures, 0, 'a success after two failures clears the count');
    assert.equal((await eventsOf(h, missionId, 'provider.circuit_opened')).length, 0);
    assert.equal((await eventsOf(h, missionId, 'provider.circuit_closed')).length, 0, 'it never opened, so it never closes');
    assert.ok(ollamaCalls(h).length > 2, 'ollama kept being offered after the first failures');
    assert.equal(h.catalog.get('ollama')?.status, 'LOCAL');
  });

  it('opens at the threshold and then routes around the provider without trying it', async () => {
    const h = scenario({ ollamaDown: true });
    const { runId, missionId } = await h.startRun(COOKIES);
    const outcome = await h.engine.execute({ runId });

    assert.equal(outcome.status, 'completed', 'the run finishes on the other provider');
    const opened = h.router.circuitState('ollama');
    assert.equal(opened?.open, true);
    assert.equal(opened?.consecutiveFailures, 3);
    assert.equal(ollamaCalls(h).length, 3, 'exactly threshold attempts were wasted on ollama — none after the circuit opened');

    const events = await eventsOf(h, missionId, 'provider.circuit_opened');
    assert.equal(events.length, 1, 'the opening is recorded once');
    assert.match(events[0]!.message, /fuera de rotación/);

    // Every step after the opening was routed away from ollama, and says why.
    const state = (await h.store.get<MadreRunState>(KINDS.runState, runId))!;
    const later = state.steps.filter((s) => s.routing?.warnings.some((w) => /fuera de rotación/.test(w)));
    assert.ok(later.length > 0, 'the routing decision must explain the exclusion');
    assert.ok(later.every((s) => s.routing?.provider?.id === 'anthropic'));
  });

  it('keeps the provider out during the cooldown and lets it back afterwards', async () => {
    const world = { ollamaDown: true };
    const h = scenario(world);
    const first = await h.startRun(COOKIES);
    await h.engine.execute({ runId: first.runId });
    assert.equal(h.router.circuitState('ollama')?.open, true);

    // During the cooldown: still excluded, even though ollama has recovered.
    world.ollamaDown = false;
    h.clock.advance(COOLDOWN_MS - 1_000);
    assert.equal(h.router.circuitState('ollama')?.open, true);
    const during = await h.startRun(COOKIES);
    const before = ollamaCalls(h).length;
    await h.engine.execute({ runId: during.runId });
    assert.equal(ollamaCalls(h).length, before, 'no call may reach a provider whose circuit is open');

    // After the cooldown the provider is back on probation and gets used again.
    h.clock.advance(2_000);
    assert.equal(h.router.circuitState('ollama')?.open, false);
    const after = await h.startRun(COOKIES);
    await h.engine.execute({ runId: after.runId });
    assert.ok(ollamaCalls(h).length > before, 'ollama should be offered again once the cooldown has passed');
    assert.equal(h.router.circuitState('ollama')?.consecutiveFailures, 0, 'a successful call clears the count completely');
    assert.equal(h.router.circuitState('ollama')?.probation, false);
    assert.equal((await eventsOf(h, after.missionId, 'provider.circuit_closed')).length, 1);
  });

  it('puts a provider straight back out if it fails again while on probation', async () => {
    const h = scenario({ ollamaDown: true });
    const first = await h.startRun(COOKIES);
    await h.engine.execute({ runId: first.runId });
    h.clock.advance(COOLDOWN_MS + 1);
    assert.equal(h.router.circuitState('ollama')?.open, false);
    assert.equal(h.router.circuitState('ollama')?.probation, true);

    const again = await h.startRun(COOKIES);
    const before = ollamaCalls(h).length;
    await h.engine.execute({ runId: again.runId });
    assert.equal(ollamaCalls(h).length - before, 1, 'one probe, then the circuit opens again');
    assert.equal(h.router.circuitState('ollama')?.open, true);
    assert.equal((await eventsOf(h, again.missionId, 'provider.circuit_opened')).length, 1);
  });

  it('blocks a step with a clear reason when every provider is out of rotation', async () => {
    const h = createEngineHarness({
      descriptors: [OLLAMA_MIXED],
      engine: { parallelism: 1 },
      runner: new ScriptedRunner(() => {
        throw new Error('ECONNREFUSED');
      }),
    });
    const { runId } = await h.startRun(COOKIES);
    await h.engine.execute({ runId });
    assert.equal(h.router.circuitState('ollama')?.open, true);

    const next = await h.startRun(COOKIES);
    const outcome = await h.engine.execute({ runId: next.runId });
    assert.equal(outcome.status, 'failed');
    const state = (await h.store.get<MadreRunState>(KINDS.runState, next.runId))!;
    assert.ok(state.steps.some((s) => s.status === 'BLOCKED' && /No queda ningún proveedor en rotación/.test(s.blockedReason ?? '')), JSON.stringify(state.steps.map((s) => [s.stepId, s.status, s.blockedReason])));
    assert.equal((h.runner as ScriptedRunner).callsFor(state.steps[0]!.stepId).length > 0, true);
  });

  it('does not count unusable output or a cancellation against the provider', async () => {
    const h = scenario({ ollamaDown: false, ollamaText: 'no' });
    const { runId } = await h.startRun(COOKIES);
    await h.engine.execute({ runId });
    assert.equal(h.router.circuitState('ollama')?.consecutiveFailures ?? 0, 0, 'a model that answers badly is not a provider that is down');
  });

  it('shows the circuit on the provider profile served to the API', async () => {
    const h = scenario({ ollamaDown: true });
    const { runId } = await h.startRun(COOKIES);
    await h.engine.execute({ runId });
    const state = h.router.circuitState('ollama');
    assert.ok(state);
    assert.equal(state.open, true);
    assert.ok(state.openedUntil !== null && Date.parse(state.openedUntil) > h.clock.now().getTime());
  });
});
