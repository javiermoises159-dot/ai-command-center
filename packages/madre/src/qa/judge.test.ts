import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RulesPlanner } from '../compiler/planner.ts';
import { createAgentRegistry } from '../registry/agents.ts';
import { createToolRegistry } from '../registry/tools.ts';
import type { ExecutionResult, MissionPlan, StepState } from '../types.ts';
import { findArithmeticErrors, evaluate, CalculatorError } from '../tools/calculator.ts';
import { RulesJudge, type JudgeSubject } from './judge.ts';
import { HUMAN_WRITING_GUIDE, lintProse } from './prose.ts';

const NOW = new Date(Date.UTC(2026, 8, 19));
const PROMPT = 'Quiero lanzar una tienda online de cookies en Italia con 5.000 euros.';
const plan = (): MissionPlan => new RulesPlanner(createAgentRegistry(), createToolRegistry()).plan(PROMPT);

function state(stepId: string, status: StepState['status'], body: string | null, provider = 'ollama', caveats: string[] = []): StepState {
  const result: ExecutionResult | null =
    body === null
      ? null
      : { stepId, agentId: 'x', status: 'DONE', text: body, provider, model: 'm', requestId: 'r', promptTokens: 1, completionTokens: 1, costUsd: 0, latencyMs: 1, attempts: 1, toolResults: [], caveats, error: null };
  return { stepId, status, attempts: 1, revisions: 0, startedAt: null, completedAt: null, routing: null, result, error: status === 'FAILED' ? 'boom' : null, blockedReason: null, waitingFor: null, executionId: null, history: [] };
}

const GOOD: Record<string, string> = {
  strategy: `Positioning: the online tienda of cookies for people in Italia who want small-batch gifts. Target segment: office workers buying for colleagues. Success criteria: 40 repeat customers by month three, a measurable metric. Main risk: demand is a hypothesis until the first pre-orders arrive, so we test that first. The wedge is gift boxes, which incumbents ignore because they sell by the kilo, and this is the part worth validating with a small pilot before anything else is built.`,
  research: `Market: online cookies sales in Italia are a hypothesis we cannot size without sources; this text comes from model knowledge and needs to be verified. Comparable players include supermarkets and two artisan shops. Constraints: food labelling rules and shipping of perishables apply, to be checked with an authority. Open questions: who buys gifts online, and what they pay today. Unknown: real demand, which needs research before any money is spent on stock or on advertising.`,
  finance: `Every figure below for the online cookies tienda in Italia is an assumption unless the user gave it. Unit cost per box is an assumption of 6; price per box is an assumption of 14; the margin is 14 - 6 = 8 per box. The break-even point is 5000 / 8 = 625 boxes, an assumed condition that holds only if the user's 5.000 euros is all fixed cost. The estimate changes with each assumption we test in the pilot, and we say which ones move it most, so the numbers can be replaced as data arrives.`,
};

function subjects(p: MissionPlan, overrides: Record<string, StepState> = {}): JudgeSubject[] {
  return p.steps
    .filter((s) => s.kind === 'agent')
    .map((step) => ({
      step,
      state: overrides[step.id] ?? state(step.id, 'DONE', GOOD[step.agentId] ?? `${step.title}: ${PROMPT} Positioning segment success risk market competitor constraint open questions stack phase risk journey visual screen message channel metric cost break-even assumption.`),
    }));
}

const judge = new RulesJudge();
const review = (p: MissionPlan, subs: JudgeSubject[], stage: 'workers' | 'final' = 'workers', finalText?: string) =>
  judge.review({ plan: p, stage, round: 1, subjects: subs, finalText: finalText ?? null, now: NOW });

describe('rules judge — workers stage', () => {
  it('passes clean, labelled, on-topic output', () => {
    const p = plan();
    const r = review(p, subjects(p));
    assert.deepEqual(r.issues.filter((i) => i.severity === 'major' || i.severity === 'blocker'), []);
    assert.ok(['PASS', 'PASS_WITH_WARNINGS'].includes(r.verdict), r.summary);
    assert.equal(r.judge.kind, 'rules');
    assert.ok(r.checklist.length >= 8);
  });

  it('never passes simulated output and does not judge its content', () => {
    const p = plan();
    const sim = subjects(p).map((s) => ({ ...s, state: state(s.step.id, 'DONE', `Simulated. ${PROMPT} `.repeat(12), 'mock') }));
    const r = review(p, sim);
    assert.equal(r.verdict, 'PASS_WITH_WARNINGS');
    assert.ok(r.issues.some((i) => i.category === 'unverified_data' && i.stepId === null && /simulad/i.test(i.message)));
    assert.ok(!r.issues.some((i) => i.category === 'hypothesis_as_fact'));
  });

  it('flags output that does not address the mission', () => {
    const p = plan();
    const subs = subjects(p, { 's-research-market': state('s-research-market', 'DONE', 'Lorem text about something unrelated entirely. '.repeat(20)) });
    const r = review(p, subs);
    assert.ok(r.issues.some((i) => i.category === 'responds_to_mission' && i.stepId === 's-research-market'));
    assert.equal(r.verdict, 'NEEDS_REVISION');
  });

  it('flags missing parts of a deliverable, scaled by how much is missing', () => {
    const p = plan();
    const short = subjects(p, { 's-strategy-positioning': state('s-strategy-positioning', 'DONE', `Cookies in Italia online shop tienda. ${'Filler about cookies and Italia. '.repeat(15)}`) });
    const r = review(p, short);
    const issue = r.issues.find((i) => i.category === 'incomplete' && i.stepId === 's-strategy-positioning');
    assert.ok(issue);
    assert.equal(issue.severity, 'major');
  });

  it('flags figures with no source or label, and accepts labelled ones', () => {
    const p = plan();
    const bad = `${GOOD.finance}\nThe market is worth 4.2 billion € and grows 12% each year in Italia for cookies.`;
    const r = review(p, subjects(p, { 's-finance-unit-economics': state('s-finance-unit-economics', 'DONE', bad.replace('Every figure below is an assumption unless the user gave it.', 'Costs follow.').replace(/assumption|assumed|estimate/g, 'number')) }));
    assert.ok(r.issues.some((i) => i.category === 'unverified_data' && i.stepId === 's-finance-unit-economics'));
    const good = review(p, subjects(p));
    assert.ok(!good.issues.some((i) => i.category === 'unverified_data'));
  });

  it('flags hypotheses stated as facts', () => {
    const p = plan();
    const text = `${GOOD.strategy} Demand is guaranteed and there is no competition in Italia for cookies.`;
    const r = review(p, subjects(p, { 's-strategy-positioning': state('s-strategy-positioning', 'DONE', text) }));
    assert.ok(r.issues.some((i) => i.category === 'hypothesis_as_fact'));
    assert.equal(r.verdict, 'NEEDS_REVISION');
    assert.equal(r.revisionRequests[0]?.stepId, 's-strategy-positioning');
  });

  it('asks a step produced without live sources to say so', () => {
    const p = plan();
    const silent = `${GOOD.strategy}`.replace('hypothesis', 'plan');
    const r = review(p, subjects(p, { 's-strategy-positioning': state('s-strategy-positioning', 'DONE', silent, 'ollama', ['No live sources.']) }));
    assert.ok(r.issues.some((i) => i.category === 'needs_research'));
    const honest = review(p, subjects(p, { 's-research-market': state('s-research-market', 'DONE', GOOD.research!, 'ollama', ['No live sources.']) }));
    assert.ok(!honest.issues.some((i) => i.category === 'needs_research'));
  });

  it('catches wrong arithmetic with the calculator', () => {
    const p = plan();
    const wrong = GOOD.finance!.replace('14 - 6 = 8', '14 - 6 = 9');
    const r = review(p, subjects(p, { 's-finance-unit-economics': state('s-finance-unit-economics', 'DONE', wrong) }));
    const issue = r.issues.find((i) => i.category === 'contradiction');
    assert.ok(issue);
    assert.match(issue.message, /14 - 6 = 9\b/);
    assert.match(issue.message, /\b8\b[^\d]*$/);
    assert.equal(r.verdict, 'NEEDS_REVISION');
  });

  it('catches contradictions between agents and against the user\'s budget', () => {
    const p = plan();
    const a = `${GOOD.strategy} The price is 20 per box.`;
    const b = `${GOOD.marketing ?? ''} ${PROMPT} message channel metric. The price is 30 per box. The budget is 9000 euros.`;
    const subs = subjects(p, {
      's-strategy-positioning': state('s-strategy-positioning', 'DONE', a),
      's-marketing-go-to-market': state('s-marketing-go-to-market', 'DONE', `${b} ${'More cookies Italia tienda content. '.repeat(10)}`),
    });
    const r = review(p, subs);
    const messages = r.issues.filter((i) => i.category === 'contradiction').map((i) => i.message);
    assert.ok(messages.some((m) => /price/.test(m) && /30|20/.test(m)), messages.join(' | '));
    assert.ok(messages.some((m) => /presupuesto de 9000/.test(m)), messages.join(' | '));
  });

  it('reports failed steps as major issues without requesting a revision of them', () => {
    const p = plan();
    const r = review(p, subjects(p, { 's-research-market': state('s-research-market', 'FAILED', null) }));
    assert.ok(r.issues.some((i) => i.category === 'incomplete' && i.severity === 'major' && i.stepId === 's-research-market'));
    assert.ok(!r.revisionRequests.some((x) => x.stepId === 's-research-market'));
  });

  it('returns BLOCKED when nothing was produced', () => {
    const p = plan();
    const none = subjects(p).map((s) => ({ ...s, state: state(s.step.id, 'FAILED', null) }));
    assert.equal(review(p, none).verdict, 'BLOCKED');
  });

  it('is deterministic apart from ids', () => {
    const p = plan();
    const strip = (r: ReturnType<typeof review>) => ({ ...r, id: '', issues: r.issues.map((i) => ({ ...i, id: '' })), revisionRequests: r.revisionRequests.map((x) => ({ ...x, issueIds: [] })) });
    assert.deepEqual(strip(review(p, subjects(p))), strip(review(p, subjects(p))));
  });
});

describe('rules judge — final stage', () => {
  const brief = (p: MissionPlan, extra = '') =>
    [
      `# ${p.compiled.expectedDeliverable.title}`,
      ...p.compiled.expectedDeliverable.sections.filter((s) => s !== 'Next actions').map((s) => `## ${s}\nThe cookie shop in Italia starts small, tests demand first and keeps the unknowns visible for the user to check.`),
      '## Next actions',
      '1. Ask ten office workers to pre-order a gift box this week.',
      '2. Check the labelling rules with the local authority before shipping anything.',
      extra,
    ].join('\n\n') + ' '.repeat(0);

  it('accepts a brief with every section and concrete next actions', () => {
    const p = plan();
    const subs = [...subjects(p), { step: p.steps.at(-1)!, state: state('s-integrate', 'DONE', brief(p)) }];
    const r = review(p, subs, 'final', brief(p));
    assert.ok(!r.issues.some((i) => i.severity === 'major'), JSON.stringify(r.issues.filter((i) => i.severity === 'major')));
    assert.equal(r.checklist.find((c) => /actuar sobre el resultado/.test(c.question))?.answer, 'yes');
  });

  it('asks for revision when next actions or sections are missing', () => {
    const p = plan();
    const thin = `# Brief\n\n## Summary\n${'The shop will sell cookies in Italia to people who want gifts. '.repeat(8)}`;
    const subs = [...subjects(p), { step: p.steps.at(-1)!, state: state('s-integrate', 'DONE', thin) }];
    const r = review(p, subs, 'final', thin);
    assert.equal(r.verdict, 'NEEDS_REVISION');
    assert.ok(r.issues.some((i) => i.category === 'actionability'));
    assert.ok(r.issues.some((i) => i.category === 'requirements'));
    assert.equal(r.revisionRequests[0]?.stepId, 's-integrate');
  });

  it('requires the brief to admit unfinished work', () => {
    const p = plan();
    const subs = [...subjects(p, { 's-research-market': state('s-research-market', 'FAILED', null) }), { step: p.steps.at(-1)!, state: state('s-integrate', 'DONE', brief(p)) }];
    const r = review(p, subs, 'final', brief(p));
    assert.ok(r.issues.some((i) => /no terminaron y el informe no lo dice/.test(i.message)));
    const honest = brief(p, 'Unresolved: the market research did not complete.');
    const ok = review(p, [...subjects(p, { 's-research-market': state('s-research-market', 'FAILED', null) }), { step: p.steps.at(-1)!, state: state('s-integrate', 'DONE', honest) }], 'final', honest);
    assert.ok(!ok.issues.some((i) => /no terminaron y el informe no lo dice/.test(i.message)));
  });

  it('attaches style findings as info that cannot change the verdict', () => {
    const p = plan();
    const flowery = brief(p, 'In conclusion, it is important to note that this game-changer will unlock the power of cookies.');
    const subs = [...subjects(p), { step: p.steps.at(-1)!, state: state('s-integrate', 'DONE', flowery) }];
    const r = review(p, subs, 'final', flowery);
    assert.ok(r.issues.some((i) => i.category === 'style' && i.severity === 'info'));
    assert.ok(!r.issues.some((i) => i.category === 'style' && i.severity !== 'info'));
  });
});

describe('calculator', () => {
  it('evaluates arithmetic exactly and rejects anything else', () => {
    assert.equal(evaluate('12 * (4 + 1.5)'), 66);
    assert.equal(evaluate('2 ^ 3 ^ 2'), 512);
    assert.equal(evaluate('10 − 3 × 2'), 4);
    assert.equal(evaluate('-(3 + 4) * 2'), -14);
    assert.equal(evaluate('7 % 4'), 3);
    for (const bad of ['', '1 +', '2 ** 3 )', 'process.exit()', '1/0', '1..2 + 3']) {
      assert.throws(() => evaluate(bad), CalculatorError, bad);
    }
    assert.throws(() => evaluate('1+'.repeat(300) + '1'), /demasiado larga/);
  });

  it('finds wrong equations in prose and ignores right ones', () => {
    assert.deepEqual(findArithmeticErrors('Contribution = 53 − 20 − 15 = **18**.'), []);
    assert.equal(findArithmeticErrors('So 6 * 7 = 43 per box').length, 1);
    assert.equal(findArithmeticErrors('Total 1,200 + 300 = 1,500').length, 0);
    assert.equal(findArithmeticErrors('x = 5 and y = 3').length, 0);
  });
});

describe('human writing layer', () => {
  it('flags stock phrases, filler openings, generic endings and even rhythm', () => {
    const rules = (t: string) => lintProse(t).map((f) => f.rule);
    assert.ok(rules('It is important to note that costs matter.').includes('stock_phrase'));
    assert.ok(rules('Certainly! Here is the plan.\n\nBody text follows here.').includes('empty_intro'));
    assert.ok(rules('The plan is short.\n\nIn conclusion, we should proceed.').includes('generic_conclusion'));
    assert.ok(rules('- We will test demand.\n- We will test price.\n- We will test channels.').includes('repetitive_structure'));
    const even = Array.from({ length: 8 }, (_, i) => `The team checks item number ${i} today.`).join(' ');
    assert.ok(rules(even).includes('even_rhythm'));
  });

  it('leaves plain direct prose alone', () => {
    const text = 'Start with ten pre-orders. If fewer than four convert, stop. The shipping rules are the real unknown, so check them first. Prices come after that, because a wrong price is cheap to fix and a wrong product is not. Then decide.';
    assert.deepEqual(lintProse(text), []);
  });

  it('ships a guide that forbids the same tells', () => {
    assert.match(HUMAN_WRITING_GUIDE, /muletillas/);
    assert.match(HUMAN_WRITING_GUIDE, /Sin saludos/);
    // The English tells must still be detected even though the guide is in Spanish.
    assert.ok(lintProse('It is important to note that costs matter.').some((f) => f.rule === 'stock_phrase'));
    assert.ok(lintProse('Cabe destacar que los costes importan.').some((f) => f.rule === 'stock_phrase'));
  });
});
