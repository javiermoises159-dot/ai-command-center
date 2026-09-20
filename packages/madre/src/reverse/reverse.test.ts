import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { planReconstruction, ReverseEngineeringRefused } from './visual.ts';

const observed = { screens: ['Home', 'Cart'], components: ['Header', 'Card'], flows: ['Checkout'], states: ['empty'], tokens: { radius: '12px' } };

describe('visual reverse engineering', () => {
  it('refuses without authorisation', () => {
    assert.throws(() => planReconstruction({ subject: 'a competitor app', authorization: 'none', observed }), ReverseEngineeringRefused);
    assert.throws(() => planReconstruction({ subject: 'x', authorization: 'unknown', observed }), ReverseEngineeringRefused);
  });

  it('requires evidence for authorised study', () => {
    assert.throws(() => planReconstruction({ subject: 'client app', authorization: 'authorized', observed }), ReverseEngineeringRefused);
    assert.throws(() => planReconstruction({ subject: 'client app', authorization: 'authorized', observed }), /autorización/);
    assert.ok(planReconstruction({ subject: 'client app', authorization: 'authorized', authorizationEvidence: 'Signed brief 2026-08-01', observed }));
  });

  it('plans from what was observed and lists assets to replace', () => {
    const p = planReconstruction({ subject: 'my app', authorization: 'own', observed });
    assert.deepEqual(p.screens, ['Home', 'Cart']);
    assert.equal(p.steps.length, 6);
    assert.ok(p.replaceWithOwn.includes('Logotipos y marcas denominativas'));
    assert.ok(p.caveats.some((c) => /no se haya observado/.test(c)));
    assert.ok(p.steps.every((x) => !/\(s\)/.test(x.detail)));
  });
});
