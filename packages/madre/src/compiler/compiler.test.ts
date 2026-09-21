import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EXAMPLE_MISSIONS } from '../fixtures/missions.ts';
import { createAgentRegistry } from '../registry/agents.ts';
import { createToolRegistry } from '../registry/tools.ts';
import { compileMission } from './compile.ts';
import { classifyIntent, detectLanguage, extractAmounts, extractPlaces, extractTimeframes } from './intent.ts';
import { INPUT_STEP_ID, INTEGRATE_STEP_ID, QA_STEP_ID, RulesPlanner, validatePlan } from './planner.ts';

const planner = () => new RulesPlanner(createAgentRegistry(), createToolRegistry());

describe('language detection', () => {
  it('tells Spanish, English and Italian apart', () => {
    assert.equal(detectLanguage('Quiero lanzar una tienda en Italia'), 'es');
    assert.equal(detectLanguage('I want to launch a shop in Italy'), 'en');
    assert.equal(detectLanguage('Voglio aprire un negozio online per i dolci'), 'it');
    assert.equal(detectLanguage(''), 'unknown');
  });
});

describe('mention extraction', () => {
  it('quotes amounts with their currency and thousands notation', () => {
    assert.deepEqual(extractAmounts('con 300 euros').map((a) => [a.value, a.currency]), [[300, 'EUR']]);
    assert.deepEqual(extractAmounts('budget of 5k EUR').map((a) => [a.value, a.currency]), [[5000, 'EUR']]);
    assert.deepEqual(extractAmounts('unos 5.000 € de presupuesto').map((a) => [a.value, a.currency]), [[5000, 'EUR']]);
    assert.deepEqual(extractAmounts('$1,200 to start').map((a) => [a.value, a.currency]), [[1200, 'USD']]);
    assert.deepEqual(extractAmounts('no numbers here'), []);
  });

  it('extracts places and timeframes only when they are in the text', () => {
    assert.deepEqual(extractPlaces('lanzar una tienda en Italia'), ['Italia']);
    assert.deepEqual(extractPlaces('sell cookies in New York and to Berlin'), ['New York', 'Berlin']);
    assert.deepEqual(extractPlaces('lanzar una tienda online'), []);
    assert.deepEqual(extractTimeframes('en 2 semanas o this month'), ['2 semanas', 'this month']);
  });
});

describe('intent classification', () => {
  it('classifies each example mission as expected', () => {
    for (const example of EXAMPLE_MISSIONS) {
      const intent = classifyIntent(example.prompt);
      assert.equal(intent.kind, example.expect.kind, example.id);
      assert.equal(intent.language, example.expect.language, example.id);
    }
  });

  it('falls back to a general mission with low confidence and asks what success means', () => {
    const intent = classifyIntent('Hola');
    assert.equal(intent.kind, 'general');
    assert.ok(intent.confidence < 0.4);
    assert.ok(intent.ambiguities.length > 0);
  });

  it('flags money, publishing and personal data without acting on them', () => {
    const intent = classifyIntent('Publish a TikTok campaign with a 500 EUR budget using our customer list');
    assert.equal(intent.sensitivity.involvesMoney, true);
    assert.equal(intent.sensitivity.involvesPublishing, true);
    assert.equal(intent.sensitivity.involvesPersonalData, true);
  });

  it('does not treat the word "clientes" alone as personal data, but does treat a customer list as such', () => {
    assert.equal(classifyIntent('Quiero conseguir mis primeros clientes para una tienda de cookies').sensitivity.involvesPersonalData, false);
    assert.equal(classifyIntent('Enviar un correo a la lista de clientes').sensitivity.involvesPersonalData, true);
    assert.equal(classifyIntent('Analizar los datos de clientes del CRM').sensitivity.involvesPersonalData, true);
  });

  it('asks about missing budget and market instead of assuming them, whatever language the mission is in', () => {
    // The questions are what the user reads, so they are always in Spanish;
    // the detection behind them has to work for Spanish and English alike.
    for (const prompt of ['Quiero lanzar una tienda online de cookies.', 'I want to launch an online cookie shop.']) {
      const intent = classifyIntent(prompt);
      assert.equal(intent.kind, 'launch_business', prompt);
      assert.ok(intent.ambiguities.some((q) => /presupuesto/i.test(q)), prompt);
      assert.ok(intent.ambiguities.some((q) => /pa[ií]s|mercado/i.test(q)), prompt);
      assert.ok(intent.ambiguities.every((q) => /[¿?]/.test(q)), prompt);
    }
  });

  it('classifies Spanish missions the English patterns would miss', () => {
    assert.equal(classifyIntent('Abrir una suscripción de café de especialidad en Berlín').kind, 'launch_business');
    assert.equal(classifyIntent('Quiero crear una app móvil para reservar pistas de pádel').kind, 'product_build');
    assert.equal(classifyIntent('Tengo una idea y quiero validarla antes de invertir').kind, 'validation_experiment');
  });

  it('strips control directives from the text it reads', () => {
    const intent = classifyIntent('Lanzar una tienda online de cookies en Italia [fail:marketing]');
    assert.ok(!intent.subject?.includes('[fail'));
  });
});

describe('mission compiler', () => {
  it('never labels anything about the outside world as verified', () => {
    for (const example of EXAMPLE_MISSIONS) {
      const compiled = compileMission(example.prompt);
      for (const s of [compiled.objective, compiled.desiredOutcome, ...compiled.context, ...compiled.assumptions, ...compiled.constraints]) {
        if (s.provenance === 'verified') assert.equal(s.source, 'MADRE permission policy', `${example.id}: ${s.text}`);
      }
      assert.equal(compiled.objective.provenance, 'user_provided');
      assert.ok(compiled.assumptions.every((a) => a.provenance === 'hypothesis'));
    }
  });

  it('records user-provided facts with their provenance and marks unknowns as needing research', () => {
    const compiled = compileMission('Quiero lanzar una tienda online de cookies en Italia.');
    assert.ok(compiled.context.some((s) => s.provenance === 'user_provided' && s.text.includes('Italia')));
    assert.ok(compiled.context.some((s) => s.provenance === 'needs_research'));
    assert.ok(compiled.openQuestions.length > 0);
  });

  it('keeps a simple request small and a broad one within the cap', () => {
    const simple = compileMission('Plan a content campaign for Nordic Oat.');
    assert.ok(simple.tasks.length <= 4);
    const broad = compileMission(
      'I want to launch an online store, research the market, validate the idea with an experiment, run a content campaign on Instagram and build a website app, with a budget of 10k EUR in 3 months.',
    );
    assert.ok(broad.tasks.length <= 8);
    assert.equal(new Set(broad.tasks.map((t) => t.capability)).size, broad.tasks.length);
  });

  it('only adds the storefront build when the mission is online', () => {
    const online = compileMission('Quiero lanzar una tienda online de cookies en Italia.');
    const physical = compileMission('Quiero abrir un negocio de cookies en Roma con 5.000 euros.');
    assert.ok(online.tasks.some((t) => t.capability === 'engineering.architecture'));
    assert.ok(!physical.tasks.some((t) => t.capability === 'engineering.architecture'));
  });

  it('includes verification criteria with a must-level coverage check', () => {
    const compiled = compileMission('Quiero lanzar una tienda online de cookies en Italia.');
    assert.ok(compiled.verificationCriteria.some((c) => c.check === 'coverage' && c.severity === 'must'));
    assert.ok(compiled.verificationCriteria.some((c) => c.check === 'actionability'));
    assert.equal(compiled.expectedDeliverable.format, 'markdown');
  });
});

describe('planner', () => {
  it('produces a sound plan for every example mission with the expected capabilities and gaps', () => {
    for (const example of EXAMPLE_MISSIONS) {
      const plan = planner().plan(example.prompt);
      assert.deepEqual(validatePlan(plan), [], example.id);
      const caps = plan.steps.map((s) => s.capability);
      for (const c of example.expect.capabilities) assert.ok(caps.includes(c), `${example.id} lacks ${c}`);
      for (const g of example.expect.gaps) assert.ok(plan.gaps.some((x) => x.capability === g), `${example.id} lacks gap ${g}`);
      const c = plan.compiled.intent.mentions;
      if (example.expect.places) assert.deepEqual(c.places, example.expect.places, example.id);
      if (example.expect.amounts) assert.deepEqual(c.amounts.map((a) => a.value), example.expect.amounts, example.id);
      if (example.expect.timeframes) assert.deepEqual(c.timeframes, example.expect.timeframes, example.id);
      assert.equal(plan.steps.some((s) => s.kind === 'input'), example.expect.needsInput === true, example.id);
    }
  });

  it('ends every plan with QA then the integrator, and QA waits for all workers', () => {
    const plan = planner().plan('Quiero lanzar una tienda online de cookies en Italia.');
    const last = plan.steps.at(-1)!;
    const qa = plan.steps.find((s) => s.id === QA_STEP_ID)!;
    assert.equal(last.id, INTEGRATE_STEP_ID);
    const workers = plan.steps.filter((s) => s.kind === 'agent');
    assert.deepEqual(qa.dependsOn.map((d) => d.stepId).sort(), workers.map((s) => s.id).sort());
    assert.ok(qa.dependsOn.every((d) => d.mode === 'soft'));
    assert.ok(last.dependsOn.some((d) => d.stepId === QA_STEP_ID && d.mode === 'hard'));
  });

  it('lets independent research run in the same wave', () => {
    const plan = planner().plan('Quiero lanzar una tienda online de cookies en Italia.');
    const first = plan.parallelGroups[0]!;
    assert.ok(first.length >= 3, `first wave was ${first.join(',')}`);
    assert.ok(first.includes('s-research-market'));
    assert.ok(first.includes('s-strategy-positioning'));
    // Economics needs positioning and market first.
    const wave = (id: string) => plan.parallelGroups.findIndex((g) => g.includes(id));
    assert.ok(wave('s-finance-unit-economics') > wave('s-strategy-positioning'));
    assert.ok(wave(QA_STEP_ID) > wave('s-finance-unit-economics'));
    assert.ok(wave(INTEGRATE_STEP_ID) > wave(QA_STEP_ID));
  });

  it('adds a hard-dependent user-input step when documents are missing, and not when supplied', () => {
    const missing = planner().plan('Analiza estos documentos y dime las acciones prioritarias.');
    const input = missing.steps.find((s) => s.id === INPUT_STEP_ID);
    assert.ok(input);
    const read = missing.steps.find((s) => s.capability === 'research.documents' && s.kind === 'agent')!;
    assert.ok(read.dependsOn.some((d) => d.stepId === INPUT_STEP_ID && d.mode === 'hard'));
    const supplied = planner().plan('Analiza estos documentos y dime las acciones prioritarias.', { providedDocuments: 1 });
    assert.equal(supplied.steps.some((s) => s.id === INPUT_STEP_ID), false);
  });

  it('reports what cannot be done in this build as non-blocking gaps and names what would close them', () => {
    const plan = planner().plan('Quiero lanzar una tienda online de cookies en Italia.');
    const web = plan.gaps.find((g) => g.capability === 'research.web')!;
    assert.equal(web.blocking, false);
    assert.ok(web.needs.includes('web.search'));
    const legal = plan.gaps.find((g) => g.capability === 'legal.compliance')!;
    assert.ok(legal.needs.includes('legal'));
    assert.ok(!plan.gaps.some((g) => g.blocking));
  });

  it('searches a research step from several angles, with unique request ids', () => {
    const plan = planner().plan('Quiero lanzar una tienda online de cookies en Italia.');
    const research = plan.steps.find((s) => s.id === 's-research-market')!;
    const searches = research.toolRequests.filter((t) => t.toolId === 'web.search');
    assert.ok(searches.length >= 2 && searches.length <= 3);
    assert.equal(new Set(searches.map((t) => t.id)).size, searches.length);
    assert.equal(new Set(searches.map((t) => JSON.stringify(t.input))).size, searches.length);
  });

  it('searches for the topic of the first sentence, not for the instructions after it, and reads a url written later', () => {
    const plan = planner().plan('Quiero abrir una tienda online de cookies artesanales en Italia. Tengo 1.500 €. Investiga la competencia y los precios habituales. Lee también esta página: https://es.wikipedia.org/wiki/Galleta');
    const research = plan.steps.find((s) => s.id === 's-research-market')!;
    const queries = research.toolRequests.filter((t) => t.toolId === 'web.search').map((t) => String(t.input.query));
    assert.ok(queries.length >= 2);
    for (const q of queries) {
      assert.match(q, /cookies/i);
      assert.doesNotMatch(q, /investiga|tengo|1\.500/i);
    }
    const fetches = research.toolRequests.filter((t) => t.toolId === 'web.fetch');
    assert.deepEqual(fetches.map((t) => t.input.url), ['https://es.wikipedia.org/wiki/Galleta']);
  });

  it('requests tools only where the agent lists them, and never requires an unavailable one', () => {
    const plan = planner().plan('Quiero lanzar una tienda online de cookies en Italia.');
    const research = plan.steps.find((s) => s.id === 's-research-market')!;
    assert.ok(research.toolRequests.some((t) => t.toolId === 'web.search' && !t.required));
    // The calculator needs an expression that does not exist until figures do, so
    // the planner does not request it — and says so, instead of requesting it with an empty input.
    const finance = plan.steps.find((s) => s.id === 's-finance-unit-economics')!;
    assert.ok(!finance.toolRequests.some((t) => t.toolId === 'math.calculator'));
    assert.ok((plan.warnings ?? []).some((w) => /math\.calculator/.test(w)), JSON.stringify(plan.warnings));
    const tools = createToolRegistry();
    for (const step of plan.steps) for (const r of step.toolRequests) if (!tools.isUsable(r.toolId)) assert.equal(r.required, false);
  });

  it('only ever plans tool calls whose input satisfies the tool schema', () => {
    const tools = createToolRegistry();
    const missions = [
      'Quiero lanzar una tienda online de cookies en Italia.',
      'Plan a content campaign for Nordic Oat.',
      'Analiza estos documentos y dime las acciones prioritarias.',
      'Necesito un modelo financiero y un presupuesto para abrir una cafetería en Turín.',
    ];
    let requests = 0;
    for (const text of missions) {
      const plan = planner().plan(text);
      for (const step of plan.steps) {
        for (const r of step.toolRequests) {
          requests += 1;
          const check = tools.validateInput(r.toolId, r.input);
          assert.ok(check.ok, `${step.id} → ${r.toolId}: ${check.errors.join(' ')}`);
        }
      }
    }
    assert.ok(requests > 0, 'the scenario should exercise at least one tool request');
  });

  it('gives memory.recall the query the schema requires, built from the mission and the task', () => {
    const plan = planner().plan('Quiero lanzar una tienda online de cookies en Italia.');
    const withRecall = plan.steps.filter((s) => s.toolRequests.some((t) => t.toolId === 'memory.recall'));
    assert.ok(withRecall.length > 0);
    for (const step of withRecall) {
      const request = step.toolRequests.find((t) => t.toolId === 'memory.recall')!;
      assert.equal(typeof request.input.query, 'string');
      assert.ok((request.input.query as string).includes(step.title), `the query should mention the task «${step.title}»`);
      assert.deepEqual(Object.keys(request.input).sort(), ['limit', 'query']);
    }
  });

  it('is deterministic apart from the plan id and timestamp', () => {
    const a = planner().plan('Quiero lanzar una tienda online de cookies en Italia.');
    const b = planner().plan('Quiero lanzar una tienda online de cookies en Italia.');
    assert.deepEqual(a.steps, b.steps);
    assert.deepEqual(a.parallelGroups, b.parallelGroups);
  });

  it('detects malformed plans', () => {
    const plan = planner().plan('Plan a content campaign for Nordic Oat.');
    plan.steps[0]!.dependsOn.push({ stepId: 'ghost', mode: 'hard' });
    assert.ok(validatePlan(plan).some((p) => /unknown step/.test(p)));
  });
});
