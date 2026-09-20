import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RateLimiter } from './rate-limit.ts';

function fakeClock(startedAt = 1_000_000) {
  let current = startedAt;
  return { now: () => current, advance: (ms: number) => (current += ms) };
}

describe('RateLimiter', () => {
  it('allows up to the ceiling and blocks the request after it', () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({ max: 3, windowMs: 60_000, now: clock.now });

    assert.deepEqual(
      [1, 2, 3].map(() => limiter.check('a').allowed),
      [true, true, true],
    );

    const blocked = limiter.check('a');
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.remaining, 0);
    assert.equal(blocked.retryAfterSeconds, 60);
  });

  it('counts each client separately', () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({ max: 1, windowMs: 60_000, now: clock.now });

    assert.equal(limiter.check('a').allowed, true);
    assert.equal(limiter.check('a').allowed, false);
    assert.equal(limiter.check('b').allowed, true, "one client's burst must not block another");
  });

  it('opens a fresh window once the old one has expired', () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({ max: 2, windowMs: 60_000, now: clock.now });

    limiter.check('a');
    limiter.check('a');
    assert.equal(limiter.check('a').allowed, false);

    clock.advance(59_999);
    assert.equal(limiter.check('a').allowed, false, 'the window has not closed yet');

    clock.advance(2);
    const fresh = limiter.check('a');
    assert.equal(fresh.allowed, true);
    assert.equal(fresh.remaining, 1);
  });

  it('reports when the window ends, so a caller can wait exactly that long', () => {
    const clock = fakeClock(1_000_000);
    const limiter = new RateLimiter({ max: 1, windowMs: 30_000, now: clock.now });

    const first = limiter.check('a');
    assert.equal(first.resetAt, 1_030_000);

    clock.advance(10_000);
    const blocked = limiter.check('a');
    assert.equal(blocked.resetAt, 1_030_000, 'a fixed window does not slide');
    assert.equal(blocked.retryAfterSeconds, 20);
  });

  it('forgets everything on reset', () => {
    const limiter = new RateLimiter({ max: 1, windowMs: 60_000 });
    assert.equal(limiter.check('a').allowed, true);
    assert.equal(limiter.check('a').allowed, false);
    limiter.reset();
    assert.equal(limiter.check('a').allowed, true);
  });

  it('does not keep expired windows around forever', () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({ max: 10, windowMs: 1_000, now: clock.now });

    // Enough distinct clients to cross the sweep threshold.
    for (let i = 0; i < 1_200; i += 1) limiter.check(`client-${i}`);
    clock.advance(2_000);
    for (let i = 0; i < 1_200; i += 1) limiter.check(`later-${i}`);

    const internal = limiter as unknown as { windows: Map<string, unknown> };
    assert.ok(internal.windows.size < 2_400, `expired windows were not swept: ${internal.windows.size}`);
  });
});
