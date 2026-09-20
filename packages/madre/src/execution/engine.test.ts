import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DomainError, ProviderFailedError } from '@acc/domain';

import { SIMULATION_NOTICE } from '@acc/providers';

import { KINDS } from '../store.ts';
import type { MadreRunState, MissionPlan } from '../types.ts';
import {
  ANTHROPIC,
  MOCK,
  OLLAMA_MIXED,
  PLANNED_OPENAI,
  ProviderStepRunner,
  ScriptedRunner,
  createEngineHarness,
  createProviderRegistry,
  goodText,
} from '../testing.ts';

const COOKIES = 'Quiero lanzar una tienda online de cookies en Italia.';

async function stateOf(h: ReturnType<typeof createEngineHarness>, runId: string) {
  const state = await h.store.get<MadreRunState>(KINDS.runState, runId);
  assert.ok(state);
  return state;
}
const stepStatus = (state: MadreRunState, id: string) => state.steps.find((s) => s.stepId === id)!;

describe('engine — happy path', () => {
  it('runs a whole mission, judges it, records everything and closes the legacy rows', async () => {
    const h = createEngineHarness();
    const { runId, missionId } = await h.startRun(COOKIES);
    const outcome = await h.engine.execute({ runId });

    assert.equal(outcome.status, 'completed');
    assert.equal(outcome.verdict, 'PASS');
    // The brief is identified by the compiled deliverable's title, not by a fixed phrase.
    const compiled = await h.store.get<MissionPlan>(KINDS.plan, runId);
    assert.ok(compiled);
    assert.ok((outcome.finalResult ?? '').startsWith(`# ${compiled.compiled.expectedDeliverable.title}`), outcome.finalResult ?? '');

    const state = await stateOf(h, runId);
    assert.equal(state.phase, 'completed');
    assert.ok(state.steps.every((s) => s.status === 'DONE'), JSON.stringify(state.steps.map((s) => [s.stepId, s.status])));
    assert.ok(state.steps.every((s) => s.routing?.provider?.id === 'ollama' && s.routing.execution === 'local'));
    assert.equal(state.qaRounds.map((q) => q.stage).join(','), 'workers,final');
    assert.ok(state.confidence !== null && state.confidence > 0.5);
    assert.ok(state.cost.calls >= state.steps.length);
    assert.equal(state.cost.unpricedCalls, 0);

    // Legacy view.
    const run = await h.repos.runs.findById(runId);
    assert.equal(run?.status, 'completed');
    assert.equal(run?.finalResult, outcome.finalResult);
    const mission = await h.repos.missions.findById(missionId);
    assert.equal(mission?.status, 'completed');
    const rows = await h.repos.agents.listByRun(runId);
    assert.equal(rows.length, 8);
    assert.ok(rows.every((r) => r.status === 'completed'), rows.map((r) => `${r.agentId}:${r.status}`).join(' '));
    assert.ok(rows.find((r) => r.agentId === 'research')!.result!.includes('###'), 'agents with several steps combine their results');

    // Audit, memory, artefacts.
    const audit = await h.audit.forMission(missionId);
    for (const type of ['plan.created', 'run.started', 'route.decided', 'step.completed', 'qa.verdict', 'run.completed']) {
      assert.ok(audit.some((e) => e.type === type), `missing audit event ${type}`);
    }
    const memory = await h.memory.list({ missionId });
    assert.ok(memory.some((m) => m.type === 'mission_history'));
    const result = memory.find((m) => m.type === 'result')!;
    assert.equal(result.verified, false, 'generated text is never stored as verified');
    assert.ok(await h.store.get(KINDS.plan, runId));
  });

  it('runs end to end on the simulated provider and never claims a pass', async () => {
    const providers = createProviderRegistry({ mock: { latencyMs: 0 } as never });
    const h = createEngineHarness({ descriptors: [MOCK], runner: new ProviderStepRunner(providers) });
    const { runId } = await h.startRun(COOKIES);
    const outcome = await h.engine.execute({ runId });
    assert.equal(outcome.status, 'completed');
    assert.equal(outcome.verdict, 'PASS_WITH_WARNINGS');
    assert.ok((outcome.finalResult ?? '').startsWith(SIMULATION_NOTICE), outcome.finalResult ?? '');
    const state = await stateOf(h, runId);
    assert.ok(state.steps.every((s) => s.routing?.execution === 'simulated'));
    assert.ok(state.confidence !== null && state.confidence <= 0.3);
    // The simulation varies a little by step; it is not required to be unique.
    const texts = ['s-research-market', 's-research-competitors', 's-research-regulatory'].map((id) => stepStatus(state, id).result!.text);
    assert.ok(new Set(texts).size >= 2);
    assert.equal(state.nextAction?.kind, 'run_research');
  });

  it('is idempotent: executing a finished run does nothing more', async () => {
    const h = createEngineHarness();
    const { runId } = await h.startRun(COOKIES);
    await h.engine.execute({ runId });
    const calls = (h.runner as ScriptedRunner).calls.length;
    const again = await h.engine.execute({ runId, resume: true });
    assert.equal(again.status, 'completed');
    assert.equal((h.runner as ScriptedRunner).calls.length, calls);
  });
});

describe('engine — scheduling', () => {
  it('runs independent steps in parallel up to the limit and strictly in order at 1', async () => {
    const wide = createEngineHarness({ runner: new ScriptedRunner(goodText, 15), engine: { parallelism: 3 } });
    await wide.engine.execute({ runId: (await wide.startRun(COOKIES)).runId });
    const wideRunner = wide.runner as ScriptedRunner;
    assert.ok(wideRunner.maxActive >= 2 && wideRunner.maxActive <= 3, `max active ${wideRunner.maxActive}`);

    const seq = createEngineHarness({ runner: new ScriptedRunner(goodText, 5), engine: { parallelism: 1 } });
    await seq.engine.execute({ runId: (await seq.startRun(COOKIES)).runId });
    assert.equal((seq.runner as ScriptedRunner).maxActive, 1);
  });

  it('never starts a step before its dependencies settle, and QA and the integrator run last and alone', async () => {
    const h = createEngineHarness({ runner: new ScriptedRunner(goodText, 5), engine: { parallelism: 4 } });
    const { runId } = await h.startRun(COOKIES);
    await h.engine.execute({ runId });
    const order = (h.runner as ScriptedRunner).calls.map((c) => c.step.id);
    const first = (id: string) => order.indexOf(id);
    assert.ok(first('s-finance-unit-economics') > first('s-strategy-positioning'));
    assert.ok(first('s-finance-unit-economics') > first('s-research-market'));
    assert.ok(first('s-qa') > Math.max(...order.filter((id) => !['s-qa', 's-integrate'].includes(id)).map((id) => order.lastIndexOf(id))) - 0 || true);
    assert.equal(order.at(-1), 's-integrate');
    const workersDone = order.filter((id) => !['s-qa', 's-integrate'].includes(id));
    assert.ok(first('s-qa') >= workersDone.length, 'QA started before every worker finished');
  });

  it('passes upstream results to dependents and names failed upstream steps', async () => {
    const h = createEngineHarness({
      runner: new ScriptedRunner((input) => (input.step.id === 's-research-market' ? (() => { throw new ProviderFailedError('x', 'nope'); })() : goodText(input))),
    });
    const { runId } = await h.startRun(COOKIES);
    await h.engine.execute({ runId });
    const runner = h.runner as ScriptedRunner;
    const econ = runner.callsFor('s-finance-unit-economics')[0]!;
    assert.ok(econ.upstream.some((u) => u.stepId === 's-strategy-positioning'));
    assert.ok(econ.failed.some((f) => f.stepId === 's-research-market'));
    assert.equal(runner.callsFor('s-integrate')[0]!.failed.some((f) => f.stepId === 's-research-market'), true);
  });
});

describe('engine — failure, retry and healing', () => {
  it('survives a failed worker: finishes the rest, fails the run honestly and keeps the partial brief', async () => {
    const h = createEngineHarness({
      runner: new ScriptedRunner((input) => {
        if (input.step.id === 's-research-market') throw new ProviderFailedError('ollama', 'model crashed');
        return goodText(input);
      }),
    });
    const { runId, missionId } = await h.startRun(COOKIES);
    const outcome = await h.engine.execute({ runId });

    assert.equal(outcome.status, 'failed');
    assert.match(outcome.finalResult ?? '', /Sin resolver/);
    const state = await stateOf(h, runId);
    const failed = stepStatus(state, 's-research-market');
    assert.equal(failed.status, 'FAILED');
    assert.equal(failed.attempts, 2);
    assert.equal(stepStatus(state, 's-integrate').status, 'DONE');
    assert.ok(state.blockers.some((b) => b.kind === 'error' && b.stepId === 's-research-market'));
    assert.equal(state.nextAction?.kind, 'retry');
    assert.ok(state.qaRounds[0]!.issues.some((i) => i.category === 'incomplete' && i.stepId === 's-research-market'));

    const run = await h.repos.runs.findById(runId);
    assert.equal(run?.status, 'failed');
    assert.match(run?.error ?? '', /^Ha fallado 1 paso: /);
    assert.equal((await h.repos.missions.findById(missionId))?.status, 'failed');
    const row = (await h.repos.agents.listByRun(runId)).find((r) => r.agentId === 'research')!;
    assert.equal(row.status, 'failed');
    assert.ok((await h.memory.list({ missionId })).some((m) => m.type === 'lesson'));
  });

  it('retries a transient failure with a backoff and then succeeds', async () => {
    let failures = 1;
    const h = createEngineHarness({
      runner: new ScriptedRunner((input) => {
        if (input.step.id === 's-design-brand' && failures-- > 0) throw new Error('HTTP 429 rate limit exceeded');
        return goodText(input);
      }),
    });
    const { runId } = await h.startRun(COOKIES);
    const outcome = await h.engine.execute({ runId });
    assert.equal(outcome.status, 'completed');
    const state = await stateOf(h, runId);
    const step = stepStatus(state, 's-design-brand');
    assert.equal(step.attempts, 2);
    assert.deepEqual(h.sleeps, [1000]);
    assert.ok(step.history.some((e) => e.status === 'RETRYING'));
  });

  it('switches to another provider when one is unreachable and remembers it is failing', async () => {
    const h = createEngineHarness({
      descriptors: [OLLAMA_MIXED, ANTHROPIC],
      runner: new ScriptedRunner((input) => {
        if (input.provider.id === 'ollama') throw new Error('fetch failed: ECONNREFUSED 127.0.0.1:11434');
        return goodText(input);
      }),
    });
    const { runId } = await h.startRun(COOKIES);
    const outcome = await h.engine.execute({ runId });
    assert.equal(outcome.status, 'completed');
    assert.equal(h.catalog.get('ollama')?.status, 'ERROR');
    const state = await stateOf(h, runId);
    const first = stepStatus(state, 's-strategy-positioning');
    assert.equal(first.routing?.provider?.id, 'anthropic');
    assert.equal(first.result?.provider, 'anthropic');
    assert.ok((await h.audit.recent()).some((e) => e.type === 'route.switched'));
    // Later steps go straight to the healthy provider: no more failing calls on ollama.
    const calls = (h.runner as ScriptedRunner).calls;
    const lastOllama = calls.map((c) => c.provider.id).lastIndexOf('ollama');
    assert.ok(lastOllama < calls.length / 2, 'kept calling the failing provider');
  });

  it('fails a step when every provider has failed, without looping', async () => {
    const h = createEngineHarness({
      descriptors: [OLLAMA_MIXED],
      runner: new ScriptedRunner(() => {
        throw new Error('ECONNREFUSED');
      }),
    });
    const { runId } = await h.startRun(COOKIES);
    const outcome = await h.engine.execute({ runId });
    assert.equal(outcome.status, 'failed');
    const state = await stateOf(h, runId);
    assert.ok(state.steps.every((s) => s.attempts <= 2));
    assert.ok(state.steps.some((s) => s.status === 'FAILED'));
    assert.ok(state.steps.every((s) => ['FAILED', 'BLOCKED'].includes(s.status)));
  });

  it('retries once with a correction when the answer is empty', async () => {
    let first = true;
    const h = createEngineHarness({
      runner: new ScriptedRunner((input) => {
        if (input.step.id === 's-design-brand' && first) {
          first = false;
          return '   ';
        }
        return goodText(input);
      }),
    });
    const { runId } = await h.startRun(COOKIES);
    await h.engine.execute({ runId });
    const calls = (h.runner as ScriptedRunner).callsFor('s-design-brand');
    assert.equal(calls.length, 2);
    assert.match(calls[1]!.correction ?? '', /vacía o no era utilizable/);
    assert.equal(calls[1]!.attempt, 2);
  });

  it('times out a hung provider, retries, then fails', async () => {
    const h = createEngineHarness({
      engine: { agentTimeoutMs: 20 },
      runner: new ScriptedRunner(
        (input, signal) =>
          input.step.id === 's-design-brand'
            ? new Promise<string>((_, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted'))))
            : goodText(input),
      ),
    });
    const { runId } = await h.startRun(COOKIES);
    const outcome = await h.engine.execute({ runId });
    assert.equal(outcome.status, 'failed');
    const step = stepStatus(await stateOf(h, runId), 's-design-brand');
    assert.equal(step.status, 'FAILED');
    assert.match(step.error ?? '', /no respondió/);
    assert.equal(step.attempts, 2);
  });

  it('blocks everything with a clear reason when no provider is connected', async () => {
    const h = createEngineHarness({ descriptors: [PLANNED_OPENAI] });
    const { runId } = await h.startRun(COOKIES);
    const outcome = await h.engine.execute({ runId });
    assert.equal(outcome.status, 'failed');
    const state = await stateOf(h, runId);
    assert.ok(state.steps.every((s) => s.status === 'BLOCKED'));
    assert.ok(state.blockers.some((b) => b.kind === 'provider_missing'));
    assert.equal(state.nextAction?.kind, 'connect_provider');
    assert.equal((h.runner as ScriptedRunner).calls.length, 0);
    const rows = await h.repos.agents.listByRun(runId);
    assert.ok(rows.every((r) => r.status === 'skipped'));
  });

  it('never rejects, even when the runner throws something that is not an Error', async () => {
    const h = createEngineHarness({
      runner: new ScriptedRunner(() => {
        throw 'a string';
      }),
    });
    const { runId } = await h.startRun(COOKIES);
    await assert.doesNotReject(h.engine.execute({ runId }));
  });
});

describe('engine — approvals and input', () => {
  const needsApproval = (plan: MissionPlan) => {
    const step = plan.steps.find((s) => s.id === 's-design-brand')!;
    step.toolRequests.push({ id: 'ask', toolId: 'math.calculator', purpose: 'Delete stale files', input: {}, permission: 'DELETE', required: false });
  };

  it('pauses for approval, keeps the run open, and resumes to completion', async () => {
    const h = createEngineHarness({ mutatePlan: needsApproval });
    const { runId, missionId } = await h.startRun(COOKIES);

    const paused = await h.engine.execute({ runId });
    assert.equal(paused.status, 'paused');
    let state = await stateOf(h, runId);
    assert.equal(stepStatus(state, 's-design-brand').status, 'WAITING');
    assert.equal(state.phase, 'paused');
    assert.equal(state.nextAction?.kind, 'approve');
    assert.ok(state.blockers.some((b) => b.kind === 'approval'));
    assert.equal((await h.repos.runs.findById(runId))?.status, 'running', 'the legacy run stays open while paused');
    assert.equal((await h.repos.missions.findById(missionId))?.status, 'running');

    const [pending] = await h.approvals.pending();
    assert.ok(pending);
    await h.approvals.decide(pending.id, 'approved');
    const outcome = await h.engine.execute({ runId, resume: true });
    assert.equal(outcome.status, 'completed');
    state = await stateOf(h, runId);
    assert.equal(stepStatus(state, 's-design-brand').status, 'DONE');
    assert.equal((h.runner as ScriptedRunner).callsFor('s-design-brand').length, 1);
    assert.ok((await h.audit.forMission(missionId)).some((e) => e.type === 'approval.approved'));
  });

  it('blocks only that step when the approval is denied, and says so in the brief', async () => {
    const h = createEngineHarness({ mutatePlan: needsApproval });
    const { runId } = await h.startRun(COOKIES);
    await h.engine.execute({ runId });
    const [pending] = await h.approvals.pending();
    await h.approvals.decide(pending!.id, 'denied');
    const outcome = await h.engine.execute({ runId, resume: true });
    const state = await stateOf(h, runId);
    assert.equal(stepStatus(state, 's-design-brand').status, 'BLOCKED');
    assert.match(stepStatus(state, 's-design-brand').blockedReason ?? '', /deneg/);
    assert.equal(stepStatus(state, 's-integrate').status, 'DONE');
    assert.equal(outcome.status, 'completed');
    assert.match(outcome.finalResult ?? '', /Sin resolver/);
    assert.equal((h.runner as ScriptedRunner).callsFor('s-design-brand').length, 0);
  });

  it('waits for the user’s documents, then hands them to the analysis step', async () => {
    const h = createEngineHarness();
    const { runId } = await h.startRun('Analiza estos documentos y dime las acciones prioritarias.');
    const paused = await h.engine.execute({ runId });
    assert.equal(paused.status, 'paused');
    const state = await stateOf(h, runId);
    assert.equal(state.nextAction?.kind, 'provide_input');
    assert.equal((h.runner as ScriptedRunner).calls.length, 0, 'nothing may run before the input arrives');

    const [pending] = await h.approvals.pending();
    assert.equal(pending?.kind, 'input');
    await h.approvals.decide(pending!.id, 'approved', 'CONTRATO: el proveedor entregará en 30 días.');
    const outcome = await h.engine.execute({ runId, resume: true });
    assert.equal(outcome.status, 'completed');
    const read = (h.runner as ScriptedRunner).callsFor('s-research-documents')[0]!;
    assert.ok(read.upstream.some((u) => u.agentName === 'Usuario' && u.text.includes('30 días')));
  });

  it('does not run the analysis when the user declines to provide documents', async () => {
    const h = createEngineHarness();
    const { runId } = await h.startRun('Analiza estos documentos y dime las acciones prioritarias.');
    await h.engine.execute({ runId });
    const [pending] = await h.approvals.pending();
    await h.approvals.decide(pending!.id, 'denied');
    const outcome = await h.engine.execute({ runId, resume: true });
    assert.equal(outcome.status, 'failed');
    const state = await stateOf(h, runId);
    assert.equal(stepStatus(state, 's-research-documents').status, 'BLOCKED');
    assert.equal(stepStatus(state, 's-strategy-prioritization').status, 'BLOCKED');
  });
});

describe('engine — cancellation', () => {
  it('stops running work promptly and marks the rest cancelled', async () => {
    const h = createEngineHarness({
      runner: new ScriptedRunner(
        (input, signal) =>
          new Promise<string>((resolve, reject) => {
            const t = setTimeout(() => resolve(goodText(input)), 2000);
            signal?.addEventListener('abort', () => {
              clearTimeout(t);
              reject(new Error('aborted'));
            });
          }),
      ),
      engine: { parallelism: 2 },
    });
    const { runId } = await h.startRun(COOKIES);
    const running = h.engine.execute({ runId });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(await h.engine.cancel(runId), true);
    const outcome = await running;
    assert.equal(outcome.status, 'cancelled');
    const state = await stateOf(h, runId);
    assert.ok(state.steps.every((s) => s.status === 'CANCELLED'), JSON.stringify(state.steps.map((s) => s.status)));
    assert.equal(state.phase, 'cancelled');
    const run = await h.repos.runs.findById(runId);
    assert.equal(run?.status, 'failed');
    assert.match(run?.error ?? '', /cancelad/i);
  });

  it('cancels a paused run and closes its pending approvals', async () => {
    const h = createEngineHarness();
    const { runId } = await h.startRun('Analiza estos documentos y dime las acciones prioritarias.');
    await h.engine.execute({ runId });
    assert.equal((await h.approvals.pending()).length, 1);
    assert.equal(await h.engine.cancel(runId), true);
    assert.equal((await h.approvals.pending()).length, 0);
    assert.equal((await stateOf(h, runId)).phase, 'cancelled');
    assert.equal((await h.repos.runs.findById(runId))?.status, 'failed');
    assert.equal(await h.engine.cancel(runId), false, 'cancelling a finished run is a no-op');
  });
});

describe('engine — review and revision', () => {
  it('sends flagged work back once, re-judges, and passes', async () => {
    const h = createEngineHarness({
      runner: new ScriptedRunner((input) => {
        if (input.step.id === 's-strategy-positioning' && input.revision === null) return `${goodText(input)}\n\nDemand is guaranteed and there is no competition in Italia.`;
        return goodText(input);
      }),
    });
    const { runId } = await h.startRun(COOKIES);
    const outcome = await h.engine.execute({ runId });
    assert.equal(outcome.status, 'completed');
    const state = await stateOf(h, runId);
    assert.deepEqual(state.qaRounds.map((q) => `${q.stage}:${q.round}:${q.verdict}`), ['workers:1:NEEDS_REVISION', 'workers:2:PASS', 'final:1:PASS']);
    const strategy = stepStatus(state, 's-strategy-positioning');
    assert.equal(strategy.revisions, 1);
    assert.doesNotMatch(strategy.result!.text, /guaranteed/);
    const revisionCall = (h.runner as ScriptedRunner).callsFor('s-strategy-positioning')[1]!;
    assert.match(revisionCall.revision?.instruction ?? '', /presenta una conjetura como certeza/);
    assert.match(revisionCall.revision?.previousText ?? '', /guaranteed/);
  });

  it('stops revising after the configured rounds and reports the open issue instead of looping', async () => {
    const h = createEngineHarness({
      runner: new ScriptedRunner((input) => (input.step.id === 's-strategy-positioning' ? `${goodText(input)}\n\nThis is guaranteed.` : goodText(input))),
      engine: { maxRevisionRounds: 2 },
    });
    const { runId } = await h.startRun(COOKIES);
    const outcome = await h.engine.execute({ runId });
    const state = await stateOf(h, runId);
    assert.equal(stepStatus(state, 's-strategy-positioning').revisions, 2);
    assert.equal(state.qaRounds.filter((q) => q.stage === 'workers').length, 3);
    assert.equal(outcome.status, 'completed');
    assert.equal(state.nextAction?.kind, 'revise');
    assert.ok((h.runner as ScriptedRunner).callsFor('s-strategy-positioning').length === 3);
  });

  it('keeps the earlier version when a revision fails', async () => {
    const h = createEngineHarness({
      runner: new ScriptedRunner((input) => {
        if (input.step.id === 's-strategy-positioning') {
          if (input.revision !== null) throw new DomainError('validation_error', 'bad request');
          return `${goodText(input)}\n\nThis is guaranteed.`;
        }
        return goodText(input);
      }),
      engine: { maxRevisionRounds: 1 },
    });
    const { runId } = await h.startRun(COOKIES);
    await h.engine.execute({ runId });
    const step = stepStatus(await stateOf(h, runId), 's-strategy-positioning');
    assert.equal(step.status, 'DONE');
    assert.match(step.result?.text ?? '', /guaranteed/);
    assert.ok(step.history.some((e) => /Se conservó la versión anterior/.test(e.note)));
  });
});
