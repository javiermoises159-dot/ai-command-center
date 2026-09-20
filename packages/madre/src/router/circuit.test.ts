import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CircuitBreaker } from './circuit.ts';
import { RulesPlanner } from '../compiler/planner.ts';
import { ANTHROPIC, FakeClock, OLLAMA_MIXED, createEngineHarness } from '../testing.ts';

const OPTIONS = { threshold: 3, cooldownMs: 60_000 };

describe('CircuitBreaker — lifecycle', () => {
  it('stays closed below the threshold and counts consecutive failures', () => {
    const breaker = new CircuitBreaker(new FakeClock(), OPTIONS);
    assert.equal(breaker.recordFailure('p').open, false);
    assert.equal(breaker.recordFailure('p').open, false);
    assert.equal(breaker.isOpen('p'), false);
    assert.equal(breaker.state('p')?.consecutiveFailures, 2);
  });

  it('opens exactly at the threshold, for the cooldown', () => {
    const clock = new FakeClock();
    const breaker = new CircuitBreaker(clock, OPTIONS);
    for (let i = 0; i < 3; i += 1) breaker.recordFailure('p');
    assert.equal(breaker.isOpen('p'), true);
    assert.equal(breaker.state('p')?.openedUntil, new Date(clock.now().getTime() + 60_000).toISOString());
  });

  it('resets the count on a success, so failures must be consecutive', () => {
    const breaker = new CircuitBreaker(new FakeClock(), OPTIONS);
    breaker.recordFailure('p');
    breaker.recordFailure('p');
    breaker.recordSuccess('p');
    breaker.recordFailure('p');
    breaker.recordFailure('p');
    assert.equal(breaker.isOpen('p'), false);
  });

  it('keeps providers independent', () => {
    const breaker = new CircuitBreaker(new FakeClock(), OPTIONS);
    for (let i = 0; i < 3; i += 1) breaker.recordFailure('a');
    assert.equal(breaker.isOpen('a'), true);
    assert.equal(breaker.isOpen('b'), false);
  });

  it('comes back on probation after the cooldown, and one success closes it', () => {
    const clock = new FakeClock();
    const breaker = new CircuitBreaker(clock, OPTIONS);
    for (let i = 0; i < 3; i += 1) breaker.recordFailure('p');
    clock.advance(59_999);
    assert.equal(breaker.isOpen('p'), true);
    clock.advance(2);
    assert.equal(breaker.isOpen('p'), false);
    assert.equal(breaker.state('p')?.probation, true);
    breaker.recordSuccess('p');
    assert.deepEqual([breaker.state('p')?.probation, breaker.state('p')?.consecutiveFailures], [false, 0]);
  });

  it('sends a provider straight back out when it fails during probation', () => {
    const clock = new FakeClock();
    const breaker = new CircuitBreaker(clock, OPTIONS);
    for (let i = 0; i < 3; i += 1) breaker.recordFailure('p');
    clock.advance(60_001);
    assert.equal(breaker.recordFailure('p').open, true, 'one failure on probation is enough');
  });
});

describe('SmartRouter — respects the circuit breaker', () => {
  const planStep = () => {
    const h = createEngineHarness({ descriptors: [OLLAMA_MIXED, ANTHROPIC] });
    const plan = new RulesPlanner(h.agents, h.tools).plan('Quiero lanzar una tienda online de cookies en Italia.');
    return { h, step: plan.steps.find((s) => s.id === 's-strategy-positioning')! };
  };

  it('routes to the preferred provider until the breaker opens, then excludes it and says why', async () => {
    const { h, step } = planStep();
    assert.equal((await h.router.route(step)).provider?.id, 'ollama');

    h.router.recordFailure('ollama');
    h.router.recordFailure('ollama');
    assert.equal((await h.router.route(step)).provider?.id, 'ollama', 'still below the threshold');

    h.router.recordFailure('ollama');
    const excluded = await h.router.route(step);
    assert.equal(excluded.provider?.id, 'anthropic');
    assert.ok(excluded.warnings.some((w) => /ollama.*fuera de rotación/i.test(w)), excluded.warnings.join(' | '));
  });

  it('offers the provider again after the cooldown and prefers it once more when it recovers', async () => {
    const { h, step } = planStep();
    for (let i = 0; i < 3; i += 1) h.router.recordFailure('ollama');
    assert.equal((await h.router.route(step)).provider?.id, 'anthropic');

    h.clock.advance(60_001);
    assert.equal((await h.router.route(step)).provider?.id, 'ollama', 'on probation it is routable again');
    h.router.recordSuccess('ollama');
    assert.equal(h.router.circuitState('ollama')?.probation, false);
    assert.equal((await h.router.route(step)).provider?.id, 'ollama');
  });

  it('blocks the step, with a reason, when the only provider is out', async () => {
    const h = createEngineHarness({ descriptors: [OLLAMA_MIXED] });
    const plan = new RulesPlanner(h.agents, h.tools).plan('Quiero lanzar una tienda online de cookies en Italia.');
    for (let i = 0; i < 3; i += 1) h.router.recordFailure('ollama');
    const decision = await h.router.route(plan.steps[0]!);
    assert.equal(decision.provider, null);
    assert.equal(decision.blocked?.kind, 'provider_missing');
    assert.match(decision.blocked?.reason ?? '', /No queda ningún proveedor en rotación/);
  });
});
