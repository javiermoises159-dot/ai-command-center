import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AffiliateConfigError, computeCommissions, preparePayouts, splitCents, validateProgram, describeWithoutProgram, type CommissionProgram, type Sale } from './affiliate.ts';
import { backtest, cappedKelly, LiveExecutionGuard, LiveTradingForbiddenError, updateBeta } from '../trading/simulation.ts';

const program: CommissionProgram = { id: 'p', name: 'P', attribution: 'last_touch', tiers: [{ fromSales: 0, rateBp: 1000 }, { fromSales: 2, rateBp: 1500 }], holdDays: 30 };
const sale = (id: string, cents: number, at: string, touches: string[], extra: Partial<Sale> = {}): Sale => ({ id, amountCents: cents, currency: 'EUR', at, touches: touches.map((a, i) => ({ affiliateId: a, at: `${at.slice(0, 10)}T0${i}:00:00Z` })), ...extra });

describe('affiliate', () => {
  it('splits cents exactly', () => {
    assert.deepEqual(splitCents(100, [1, 1, 1]).reduce((a, b) => a + b, 0), 100);
    assert.deepEqual(splitCents(0, [1, 2]), [0, 0]);
  });

  it('uses only configured rates and tiers by prior sales', () => {
    const l = computeCommissions({ program, now: '2026-09-19T00:00:00Z', sales: [sale('1', 10_000, '2026-01-01T00:00:00Z', ['a']), sale('2', 10_000, '2026-01-02T00:00:00Z', ['a']), sale('3', 10_000, '2026-01-03T00:00:00Z', ['a'])] });
    assert.deepEqual(l.map((e) => e.amountCents), [1000, 1000, 1500]);
    assert.ok(l.every((e) => e.state === 'payable'));
  });

  it('keeps a commission pending during the hold period and reverses a full refund', () => {
    const l = computeCommissions({ program, now: '2026-01-10T00:00:00Z', sales: [sale('1', 10_000, '2026-01-05T00:00:00Z', ['a']), sale('2', 5_000, '2026-01-01T00:00:00Z', ['b'], { refundedCents: 5_000 })] });
    assert.equal(l.find((e) => e.saleId === '1')?.state, 'pending');
    const refunded = l.find((e) => e.saleId === '2');
    assert.equal(refunded?.state, 'reversed');
    assert.equal(refunded?.amountCents, 0);
  });

  it('attribution models credit different affiliates and never exceed the base', () => {
    const s = sale('1', 10_001, '2026-01-01T00:00:00Z', ['a', 'b', 'b']);
    const first = computeCommissions({ program: { ...program, attribution: 'first_touch' }, now: '2027-01-01T00:00:00Z', sales: [s] });
    const last = computeCommissions({ program: { ...program, attribution: 'last_touch' }, now: '2027-01-01T00:00:00Z', sales: [s] });
    const linear = computeCommissions({ program: { ...program, attribution: 'linear' }, now: '2027-01-01T00:00:00Z', sales: [s] });
    assert.equal(first[0]?.affiliateId, 'a');
    assert.equal(last[0]?.affiliateId, 'b');
    assert.equal(linear.length, 2);
    assert.ok(linear.reduce((a, e) => a + e.amountCents, 0) <= 10_001 * 0.1);
  });

  it('adds an override only when configured', () => {
    const withOverride = computeCommissions({ program: { ...program, overrideBp: 200 }, parents: { a: 'boss' }, now: '2027-01-01T00:00:00Z', sales: [sale('1', 10_000, '2026-01-01T00:00:00Z', ['a'])] });
    assert.deepEqual(withOverride.map((e) => [e.affiliateId, e.amountCents]), [['a', 1000], ['boss', 200]]);
    const without = computeCommissions({ program, parents: { a: 'boss' }, now: '2027-01-01T00:00:00Z', sales: [sale('1', 10_000, '2026-01-01T00:00:00Z', ['a'])] });
    assert.equal(without.length, 1);
  });

  it('rejects invalid programs instead of guessing', () => {
    assert.ok(validateProgram({ ...program, tiers: [] }).length > 0);
    assert.ok(validateProgram({ ...program, tiers: [{ fromSales: 0, rateBp: 20_000 }] }).length > 0);
    assert.throws(() => computeCommissions({ program: { ...program, tiers: [] }, sales: [], now: '2026-01-01T00:00:00Z' }), AffiliateConfigError);
    assert.match(describeWithoutProgram(), /no da por supuestos los porcentajes de comisión/);
  });

  it('prepares payout requests that are FINANCIAL and never executed', () => {
    const l = computeCommissions({ program, now: '2027-01-01T00:00:00Z', sales: [sale('1', 10_000, '2026-01-01T00:00:00Z', ['a'])] });
    const p = preparePayouts(l);
    assert.equal(p.length, 1);
    assert.equal(p[0]?.permission, 'FINANCIAL');
    assert.equal(p[0]?.executed, false);
    assert.equal(preparePayouts(l, 5_000).length, 0);
  });
});

const bars = (closes: number[]) => closes.map((close, i) => ({ t: `d${i}`, close }));

describe('trading simulation', () => {
  it('is labelled simulation and carries caveats', () => {
    const r = backtest({ bars: bars([10, 11, 12, 11, 13]), signal: () => 1, startingCash: 1000, feeRate: 0 });
    assert.equal(r.mode, 'simulation');
    assert.ok(r.caveats.some((c) => /No predice resultados futuros/.test(c)));
    assert.ok(r.caveats.some((c) => /demasiado pocas/.test(c)));
    assert.ok(r.caveats.every((c) => !/\(s\)/.test(c)));
  });

  it('acts on the next bar so a signal cannot trade on the price that produced it', () => {
    // Signal is long only on the last bar; with no later bar there is no trade at all.
    const r = backtest({ bars: bars([10, 10, 20]), signal: (c, i) => (i === 2 ? 1 : 0), startingCash: 1000, feeRate: 0 });
    assert.equal(r.endingEquity, 1000);
  });

  it('computes return, fees and drawdown', () => {
    const r = backtest({ bars: bars([100, 100, 110, 99, 99]), signal: (_c, i) => (i <= 2 ? 1 : 0), startingCash: 1000, feeRate: 0 });
    assert.equal(r.trades.length, 1);
    assert.ok(r.totalReturnPct < 0 && r.maxDrawdownPct > 0);
    const fees = backtest({ bars: bars([100, 100, 100, 100]), signal: (_c, i) => (i === 0 || i === 1 ? 1 : 0), startingCash: 1000, feeRate: 0.01 });
    assert.ok(fees.endingEquity < 1000);
  });

  it('rejects bad inputs', () => {
    assert.throws(() => backtest({ bars: bars([1, -1]), signal: () => 1, startingCash: 10, feeRate: 0 }), RangeError);
    assert.throws(() => backtest({ bars: bars([1]), signal: () => 1, startingCash: 0, feeRate: 0 }), RangeError);
  });

  it('caps Kelly and floors it at zero', () => {
    assert.equal(cappedKelly(0.9, 3), 0.25);
    assert.equal(cappedKelly(0.3, 1), 0);
    assert.throws(() => cappedKelly(2, 1), RangeError);
  });

  it('updates a win-rate belief', () => {
    const u = updateBeta({ alpha: 1, beta: 1 }, 7, 3);
    assert.equal(u.mean, 8 / 12);
  });

  it('refuses every live-trading call', () => {
    assert.equal(LiveExecutionGuard.connected, false);
    assert.throws(() => LiveExecutionGuard.placeOrder(), LiveTradingForbiddenError);
    assert.throws(() => LiveExecutionGuard.cancelOrder(), LiveTradingForbiddenError);
    assert.throws(() => LiveExecutionGuard.connect(), LiveTradingForbiddenError);
  });
});
