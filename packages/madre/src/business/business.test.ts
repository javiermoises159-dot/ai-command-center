import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { assessOpportunity, OPPORTUNITY_STAGES } from './opportunity.ts';

describe('opportunity engine', () => {
  it('covers the eight stages in order', () => {
    assert.deepEqual(assessOpportunity('cookies').stages.map((s) => s.stage), [...OPPORTUNITY_STAGES]);
  });

  it('with nothing supplied everything is unknown and the idea is not called good', () => {
    const b = assessOpportunity('cookies in Italy');
    assert.equal(b.readiness.unknown, 8);
    assert.match(b.verdict, /No se ha demostrado que la idea sea buena/);
    assert.equal(b.experiment.stage, 'PROBLEM');
  });

  it('distinguishes evidenced from assumed and tests the riskiest gap next', () => {
    const b = assessOpportunity('cookies', {
      PROBLEM: { statement: 'People want fresh gluten-free cookies', evidence: ['8 of 10 interviews'] },
      CUSTOMER: { statement: 'Office managers will buy' },
    });
    assert.equal(b.stages.find((s) => s.stage === 'PROBLEM')?.status, 'evidenced');
    assert.equal(b.stages.find((s) => s.stage === 'CUSTOMER')?.status, 'assumed');
    assert.equal(b.experiment.stage, 'CUSTOMER');
    assert.match(b.experiment.hypothesis, /Office managers will buy/);
    assert.equal(b.riskiest[0]?.stage, 'CUSTOMER');
  });

  it('even with full evidence it does not claim success', () => {
    const inputs = Object.fromEntries(OPPORTUNITY_STAGES.map((s) => [s, { statement: 'x', evidence: ['e'] }]));
    const b = assessOpportunity('x', inputs);
    assert.equal(b.readiness.evidenced, 8);
    assert.match(b.verdict, /no demuestra que la idea vaya a funcionar/);
  });

  it('experiments carry a failure threshold, and invent no numbers', () => {
    const b = assessOpportunity('x');
    assert.ok(b.experiment.failureThreshold.length > 0);
    assert.equal(/\d+\s?%/.test(JSON.stringify(b.experiment)), false);
  });
});
