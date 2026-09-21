/**
 * MADRE end to end over the REAL provider adapters, with a fake `fetch` at the
 * HTTP level and no network.
 *
 * Nothing between the mission and the wire is replaced: the compiler, the DAG
 * planner, the Smart Router, the cost controller, the engine, the step runner,
 * the actual OpenAI/Anthropic adapter, the tool pipeline, the QA judge, the run
 * state, the audit log and the trace are the production classes. Only `fetch`
 * is fake — it plays the vendor.
 */

import assert from 'node:assert/strict';
import type { ProviderTask } from '@acc/domain';
import { describe, it } from 'node:test';

import type { CostRecord, MadreRunState, MissionTrace } from '../types.ts';
import { buildTrace } from '../observability/trace.ts';
import { KINDS } from '../store.ts';
import type { MissionPlan } from '../types.ts';
import { createEngineHarness, createProviderRegistry, goodText } from '../testing.ts';
import type { StepRunInput } from './runner.ts';

const COOKIES = 'Quiero lanzar una tienda online de cookies en Italia.';
const KEY = 'sk-test-FAKEFAKEFAKE1234567890';
const ANT_KEY = 'sk-ant-test-FAKEFAKEFAKE1234567890';
const PRICES = { 'openai:gpt-test': { inputPer1kUsd: 0.001, outputPer1kUsd: 0.002 }, 'anthropic:claude-test': { inputPer1kUsd: 0.003, outputPer1kUsd: 0.015 } };

// ---- a fake vendor -----------------------------------------------------------

interface Reply {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  delayMs?: number;
}
interface Seen {
  url: string;
  headers: Record<string, string>;
  body: any;
  signal: AbortSignal | undefined;
}

/**
 * The text a model would write for a prompt MADRE built. The prompt is parsed
 * back into the few fields `goodText` needs, so the answers satisfy the judge
 * the way a competent model's would.
 */
function vendorText(prompt: string): string {
  const kind = prompt.includes('OUTPUT FROM THE CREW') ? 'integrate' : prompt.includes('SPECIALIST OUTPUT TO AUDIT') ? 'qa' : 'agent';
  const mission = /MISSION\n([^\n]+)/.exec(prompt)?.[1] ?? COOKIES;
  const deliverable = /Write "(.+?)" with these sections: (.+?)\. End with/.exec(prompt);
  const failed = [...(/STEPS THAT DID NOT COMPLETE\n([\s\S]*?)\n\nDo not invent/.exec(prompt)?.[1] ?? '').matchAll(/^- (.+?) \(/gm)].map((m) => ({ title: m[1]! }));
  const input = {
    missionPrompt: mission,
    step: { kind, title: 'Análisis' },
    plan: { deliverableTitle: deliverable?.[1] ?? 'Informe', deliverableSections: (deliverable?.[2] ?? 'Resumen').split(', ') },
    failed,
    caveats: prompt.includes('LIMITS OF THIS STEP') ? ['sin fuentes'] : [],
    reviewSummary: null,
  } as unknown as StepRunInput;
  return goodText(input);
}

function vendor(reply: Reply | ((seen: Seen, index: number) => Reply) = {}) {
  const seen: Seen[] = [];
  const fetch = async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => {
    const call: Seen = { url, headers: init?.headers ?? {}, body: init?.body === undefined ? undefined : JSON.parse(init.body), signal: init?.signal };
    seen.push(call);
    const r = typeof reply === 'function' ? reply(call, seen.length - 1) : reply;
    if (r.delayMs !== undefined) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, r.delayMs);
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    }
    const status = r.status ?? 200;
    const headers = Object.fromEntries(Object.entries(r.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const isOpenAI = url.includes('openai') || url.includes('/chat/completions');
    const body =
      r.body ??
      (isOpenAI
        ? { id: `chatcmpl-${seen.length}`, choices: [{ message: { role: 'assistant', content: vendorText(String(call.body?.messages?.[1]?.content ?? '')) }, finish_reason: 'stop' }], usage: { prompt_tokens: 1500, completion_tokens: 700, total_tokens: 2200 } }
        : { id: `msg_${seen.length}`, content: [{ type: 'text', text: vendorText(String(call.body?.messages?.[0]?.content ?? '')) }], stop_reason: 'end_turn', usage: { input_tokens: 1500, output_tokens: 700 } });
    return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body), headers: { get: (n: string) => headers[n.toLowerCase()] ?? null } };
  };
  return { fetch, seen };
}

type Vendor = ReturnType<typeof vendor>;

function setup(options: { openai?: Vendor; anthropic?: Vendor; noKeys?: boolean; budget?: Parameters<typeof createEngineHarness>[0] extends infer O ? (O extends { budget?: infer B } ? B : never) : never; prices?: typeof PRICES | Record<string, never>; engine?: { agentTimeoutMs?: number; parallelism?: number } } = {}) {
  const registry = createProviderRegistry({
    mock: { minLatencyMs: 0, maxLatencyMs: 0 },
    ...(options.openai !== undefined ? { openai: { apiKey: KEY, models: ['gpt-test'], fetch: options.openai.fetch } } : {}),
    ...(options.anthropic !== undefined ? { anthropic: { apiKey: ANT_KEY, models: ['claude-test'], fetch: options.anthropic.fetch } } : {}),
  });
  const h = createEngineHarness({
    providerRegistry: registry,
    prices: options.prices ?? PRICES,
    ...(options.budget !== undefined ? { budget: options.budget } : {}),
    engine: { parallelism: 1, ...options.engine },
  });
  return h;
}
type Harness = ReturnType<typeof setup>;

async function run(h: Harness, prompt = COOKIES) {
  const { missionId, runId } = await h.startRun(prompt);
  const outcome = await h.engine.execute({ runId });
  const state = (await h.store.get<MadreRunState>(KINDS.runState, runId))!;
  const plan = await h.store.get<MissionPlan>(KINDS.plan, runId);
  const audit = await h.audit.forMission(missionId, 2000);
  const costs = (await h.store.list<CostRecord>(KINDS.cost, { runId, order: 'asc' })).filter((c) => c.kind === 'model');
  const trace: MissionTrace = buildTrace({ missionId, runId, plan, state, qaRounds: state.qaRounds, costs, audit });
  return { missionId, runId, outcome, state, plan, audit, costs, trace };
}

const events = (r: { audit: { type: string }[] }, type: string) => r.audit.filter((e) => e.type === type) as any[];

describe('engine over real provider adapters', () => {
  it('runs a whole mission: compiler → planner → router → OpenAI adapter → tools → QA → result → trace', async () => {
    const openai = vendor();
    const h = setup({ openai });
    const r = await run(h);

    assert.equal(r.outcome.status, 'completed');
    assert.ok(r.outcome.finalResult !== null && r.outcome.finalResult.length > 100);

    // Every model call went to the real adapter's endpoint, with the credential in its header.
    assert.ok(openai.seen.length >= 8, `expected one call per agent step, saw ${openai.seen.length}`);
    for (const call of openai.seen) {
      assert.ok(call.url.endsWith('/chat/completions'));
      assert.equal(call.headers['authorization'], `Bearer ${KEY}`);
      assert.equal(call.body.model, 'gpt-test');
      assert.ok(String(call.body.messages[1].content).includes('YOUR TASK'), 'the step prompt reached the vendor');
    }

    // Every result says a real model ran — none is labelled mock or simulated.
    const done = r.state.steps.filter((s) => s.result !== null);
    assert.ok(done.length >= 8);
    for (const s of done) {
      assert.equal(s.result!.provider, 'openai');
      assert.equal(s.result!.model, 'gpt-test');
      assert.equal(s.result!.source, 'real');
      assert.equal(s.result!.simulated, false);
      assert.ok(s.result!.requestId !== null && s.result!.requestId.startsWith('chatcmpl-'));
    }
    assert.equal(r.state.steps.some((s) => s.result?.provider === 'mock'), false);

    // The trace can rebuild each step: router decision, provider, model, attempt, timing, cost, QA.
    for (const t of r.trace.steps.filter((s) => s.provider !== null)) {
      assert.equal(t.provider, 'openai');
      assert.equal(t.source, 'real');
      assert.equal(t.simulated, false);
      assert.equal(t.router?.selectedProvider, 'openai');
      assert.equal(t.router?.selectedModel, 'gpt-test');
      assert.ok((t.router?.excludedCandidates ?? []).some((e) => e.providerId === 'anthropic' && e.code === 'unconfigured'));
      assert.ok(t.providerCalls.length >= 1);
      const call = t.providerCalls.at(-1)!;
      assert.equal(call.outcome, 'succeeded');
      assert.equal(call.provider, 'openai');
      assert.equal(call.model, 'gpt-test');
      assert.equal(call.source, 'real');
      assert.equal(call.simulated, false);
      assert.ok(call.startedAt <= (call.endedAt ?? ''));
      assert.equal(call.promptTokens, 1500);
      assert.equal(call.completionTokens, 700);
      assert.ok(call.requestId?.startsWith('chatcmpl-'));
      assert.ok(t.costUsd !== null && t.costUsd > 0);
      assert.equal(t.providerError, null);
    }
    assert.ok(r.trace.qaRounds.length >= 1, 'QA ran on the real results');
  });

  it('leaves the audit trail the spec asks for, in order, for every call', async () => {
    const h = setup({ openai: vendor() });
    const r = await run(h);
    const types = new Set(r.audit.map((e) => e.type));
    for (const type of ['provider.selected', 'provider.request_started', 'provider.request_succeeded', 'provider.cost_recorded', 'provider.unconfigured']) {
      assert.ok(types.has(type), `missing audit event ${type}`);
    }
    // One start, one success and one cost line per call.
    const started = events(r, 'provider.request_started').length;
    assert.equal(events(r, 'provider.request_succeeded').length, started);
    assert.equal(events(r, 'provider.cost_recorded').length, started);
    assert.ok(started >= 8);
    // provider.selected carries the full explanation.
    const selected = events(r, 'provider.selected')[0];
    assert.equal(selected.data.selectedProvider, 'openai');
    assert.equal(selected.data.source, 'real');
    assert.ok(selected.data.candidates.some((c: any) => c.provider === 'openai' && c.selected));
    assert.ok(selected.data.excluded.some((e: any) => e.provider === 'anthropic' && e.errorCode === 'PROVIDER_UNCONFIGURED'));
    // Unconfigured providers are reported once per run, not once per step.
    const unconfigured = events(r, 'provider.unconfigured');
    assert.deepEqual(unconfigured.map((e) => e.data.provider).sort(), ['anthropic', 'gemini', 'ollama', 'openai-compatible'].sort());
    // A request is started before it succeeds.
    for (const s of r.trace.steps.filter((x) => x.providerCalls.length > 0)) {
      for (const c of s.providerCalls) assert.ok(c.startedAt <= (c.endedAt ?? c.startedAt));
    }
  });

  it('records the cost of every call from the configured price, and never as zero when the price is unknown', async () => {
    const priced = setup({ openai: vendor() });
    const p = await run(priced);
    const first = p.costs[0]!;
    assert.equal(first.provider, 'openai');
    assert.equal(first.source, 'real');
    assert.equal(first.estimatedUsd, 0.0029); // 1.5k × 0.001 + 0.7k × 0.002
    assert.ok(first.requestId?.startsWith('chatcmpl-'));
    assert.equal(p.trace.cost.unpricedCalls, 0);
    assert.equal(events(p, 'provider.cost_recorded')[0].data.costUsd, 0.0029);
    assert.equal(events(p, 'provider.cost_recorded')[0].data.priced, true);

    const unpriced = setup({ openai: vendor(), prices: {} });
    const u = await run(unpriced);
    assert.equal(u.outcome.status, 'completed', 'no budget: an unpriced call is allowed');
    assert.ok(u.costs.every((c) => c.estimatedUsd === null && c.actualUsd === null), 'the cost is unknown, not 0');
    assert.equal(u.trace.cost.unpricedCalls, u.costs.length);
    assert.ok(u.state.steps.filter((s) => s.result !== null).every((s) => s.result!.costUsd === null));
    const recorded = events(u, 'provider.cost_recorded')[0];
    assert.equal(recorded.data.costUsd, null);
    assert.equal(recorded.data.priced, false);
    assert.match(recorded.message, /sin precio conocido/);
  });

  it('with a budget and an unknown price nothing is executed: no request leaves, and the step says PROVIDER_COST_UNKNOWN', async () => {
    const openai = vendor();
    const h = setup({ openai, prices: {}, budget: { perMissionUsd: 5, dailyUsd: null, monthlyUsd: null, perAgentUsd: {}, perToolUsd: {}, alertAtFraction: 0.8, onExceed: 'block' } });
    const r = await run(h);

    assert.equal(openai.seen.length, 0, 'rejected before executing');
    assert.notEqual(r.outcome.status, 'completed');
    const blocked = r.state.steps.filter((s) => s.status === 'BLOCKED' && s.providerError);
    assert.ok(blocked.length > 0);
    assert.ok(blocked.every((s) => s.providerError?.code === 'PROVIDER_COST_UNKNOWN' && s.providerError.stage === 'cost'));
    assert.match(blocked[0]!.blockedReason ?? '', /Se desconoce el precio/);
    assert.equal(r.state.steps.some((s) => s.result?.provider === 'mock'), false, 'and it is not answered by the simulation instead');
  });

  it('a step the router blocks still carries its structured error in the trace', async () => {
    const h = setup({ openai: vendor(), prices: {}, budget: { perMissionUsd: 5, dailyUsd: null, monthlyUsd: null, perAgentUsd: {}, perToolUsd: {}, alertAtFraction: 0.8, onExceed: 'block' } });
    const r = await run(h);
    const t = r.trace.steps.find((s) => s.status === 'BLOCKED')!;
    assert.equal(t.providerError?.code, 'PROVIDER_COST_UNKNOWN');
    assert.ok(t.router?.excludedCandidates.some((e) => e.code === 'cost_unknown'));
  });

  describe('when nothing real is configured', () => {
    it('uses the simulation only because there is nothing else, and every result says so', async () => {
      const h = setup({});
      const r = await run(h);
      assert.equal(r.outcome.status, 'completed');
      const results = r.state.steps.filter((s) => s.result !== null).map((s) => s.result!);
      assert.ok(results.length >= 8);
      for (const res of results) {
        assert.equal(res.provider, 'mock');
        assert.equal(res.source, 'mock');
        assert.equal(res.simulated, true);
      }
      assert.ok(r.trace.steps.filter((s) => s.provider !== null).every((s) => s.source === 'mock' && s.simulated === true));
      assert.ok(r.costs.every((c) => c.source === 'mock' && c.estimatedUsd === 0));
      // The real providers are reported as unconfigured, not as failed.
      assert.equal(events(r, 'provider.unconfigured').length, 5);
      assert.equal(events(r, 'provider.request_failed').length, 0);
    });

    it('QA does not treat a simulation as evidence: the verdict is capped, while a real run is not', async () => {
      const mock = await run(setup({}));
      const real = await run(setup({ openai: vendor() }));
      const verdict = (r: typeof mock) => r.state.qaRounds.at(-1)!.verdict;
      assert.notEqual(verdict(mock), 'PASS', 'a simulation cannot pass');
      assert.ok(mock.state.qaRounds.at(-1)!.issues.some((i) => /simulad/i.test(i.message)), 'and the reason names the simulation');
      assert.ok(!real.state.qaRounds.at(-1)!.issues.some((i) => /simulad/i.test(i.message)), 'a real run is never accused of being a simulation');
    });
  });

  describe('failures', () => {
    it('a rejected key (401) takes the provider out of service, is NOT counted by the circuit breaker, and is not answered by the simulation', async () => {
      const openai = vendor({ status: 401, body: { error: { message: `Incorrect API key provided: ${KEY}` } } });
      const h = setup({ openai });
      const r = await run(h);

      assert.notEqual(r.outcome.status, 'completed');
      assert.equal(openai.seen.length, 1, 'one request; after the rejection the provider is out of service');
      assert.equal(r.state.steps.some((s) => s.result !== null), false, 'no step got a (simulated) answer');

      // The permanent error is classified as configuration, not as flakiness.
      const failed = events(r, 'provider.request_failed')[0];
      assert.equal(failed.data.code, 'PROVIDER_AUTH_FAILED');
      assert.equal(failed.data.stage, 'request');
      assert.equal(failed.data.retryable, false);
      assert.equal(failed.data.provider, 'openai');
      assert.equal(failed.data.model, 'gpt-test');
      assert.match(failed.message, /OPENAI_API_KEY/);
      assert.equal(h.router.circuitState('openai')?.consecutiveFailures ?? 0, 0);
      assert.equal(events(r, 'provider.circuit_opened').length, 0);
      const excluded = events(r, 'provider.excluded').find((e) => e.data.permanent === true);
      assert.equal(excluded.data.errorCode, 'PROVIDER_AUTH_FAILED');

      // …and it now shows as ERROR in the catalog, with the reason, until the operator fixes it.
      const profile = h.catalog.get('openai')!;
      assert.equal(profile.status, 'ERROR');
      assert.equal(profile.executable, false);
      assert.match(profile.statusDetail, /rechazó las credenciales/);

      const failedStep = r.trace.steps.find((s) => s.providerError !== null)!;
      assert.equal(failedStep.providerError?.code, 'PROVIDER_AUTH_FAILED');
      assert.equal(failedStep.providerCalls.at(-1)?.outcome, 'failed');
    });

    it('transient failures (503) count against the circuit; at the threshold it opens and the router stops offering the provider', async () => {
      const openai = vendor({ status: 503, body: { error: { message: 'overloaded' } } });
      const h = setup({ openai });
      const r = await run(h);

      assert.notEqual(r.outcome.status, 'completed');
      assert.equal(r.state.steps.some((s) => s.result?.provider === 'mock'), false, 'the simulation never takes over from a failing real provider');
      const opened = events(r, 'provider.circuit_opened');
      assert.equal(opened.length, 1);
      assert.equal(opened[0].data.failures, 3);
      assert.equal(opened[0].data.failureClass, 'PROVIDER_UNAVAILABLE');
      assert.equal(h.router.circuitState('openai')?.open, true);
      assert.equal(h.catalog.get('openai')?.status, 'ERROR');
      // After it opened, no further request was sent to the provider.
      assert.equal(openai.seen.length, 3);
      assert.ok(events(r, 'provider.excluded').some((e) => e.data.code === 'circuit_open' && e.data.errorCode === 'PROVIDER_CIRCUIT_OPEN'));
      assert.ok(r.state.steps.some((s) => s.providerError?.code === 'PROVIDER_CIRCUIT_OPEN' || s.providerError?.code === 'PROVIDER_UNAVAILABLE'));
    });

    it('cooldown → half-open → a successful probe closes the circuit; a failed probe opens it again', async () => {
      let healthy = false;
      const openai = vendor(() => (healthy ? {} : { status: 503, body: { error: { message: 'overloaded' } } }));
      const h = setup({ openai });
      const first = await run(h);
      assert.equal(h.router.circuitState('openai')?.open, true);
      assert.equal(events(first, 'provider.circuit_opened').length, 1);
      const callsWhenOpen = openai.seen.length;

      // Still cooling down: the provider is not called at all.
      h.clock.advance(30_000);
      await run(h);
      assert.equal(openai.seen.length, callsWhenOpen);

      // Cooldown over, provider still down: the probe fails and the circuit reopens at once.
      h.clock.advance(31_000);
      const probeFails = await run(h);
      assert.equal(events(probeFails, 'provider.circuit_half_open').length, 1, 'the transition is audited');
      assert.equal(openai.seen.length, callsWhenOpen + 1, 'exactly one probe call');
      assert.equal(h.router.circuitState('openai')?.open, true);
      assert.equal(events(probeFails, 'provider.circuit_opened').length, 1, 'reopened by the failed probe');

      // Cooldown over again, provider back: the probe succeeds and the circuit closes.
      healthy = true;
      h.clock.advance(61_000);
      const probeWorks = await run(h);
      assert.equal(events(probeWorks, 'provider.circuit_half_open').length, 1);
      assert.equal(events(probeWorks, 'provider.circuit_closed').length, 1);
      assert.equal(h.router.circuitState('openai')?.open, false);
      assert.equal(h.router.circuitState('openai')?.consecutiveFailures, 0);
      assert.equal(probeWorks.outcome.status, 'completed');
      assert.equal(h.catalog.get('openai')?.status, 'CONNECTED');
    });

    it('a rate limit is retried after the wait the vendor asked for, then succeeds', async () => {
      let limited = true;
      const openai = vendor((_, i) => {
        if (i === 0 && limited) {
          limited = false;
          return { status: 429, headers: { 'retry-after': '3' }, body: { error: { message: 'Rate limit reached' } } };
        }
        return {};
      });
      const h = setup({ openai });
      const r = await run(h);
      assert.equal(r.outcome.status, 'completed');
      const failed = events(r, 'provider.request_failed');
      assert.equal(failed.length, 1);
      assert.equal(failed[0].data.code, 'PROVIDER_RATE_LIMITED');
      assert.equal(failed[0].data.retryable, true);
      assert.ok(h.sleeps.includes(3000), `backed off for the Retry-After (slept ${JSON.stringify(h.sleeps)})`);
      const retried = r.trace.steps.find((s) => s.providerCalls.length === 2)!;
      assert.deepEqual(retried.providerCalls.map((c) => c.outcome), ['failed', 'succeeded']);
      assert.deepEqual(retried.providerCalls.map((c) => c.attempt), [1, 2]);
      assert.equal(retried.status, 'DONE');
      assert.equal(h.router.circuitState('openai')?.consecutiveFailures, 0, 'the success cleared the count');
    });

    it('an engine timeout aborts the in-flight request and is recorded as PROVIDER_TIMEOUT', async () => {
      const openai = vendor({ delayMs: 10_000 });
      const h = setup({ openai, engine: { agentTimeoutMs: 40 } });
      const started = Date.now();
      const r = await run(h);
      assert.ok(Date.now() - started < 5_000);
      assert.ok(openai.seen[0]!.signal?.aborted, 'the request was aborted, not abandoned');
      const failed = events(r, 'provider.request_failed')[0];
      assert.equal(failed.data.code, 'PROVIDER_TIMEOUT');
      assert.equal(failed.data.retryable, true);
      assert.notEqual(r.outcome.status, 'completed');
    });

    it('cancelling stops the in-flight request and records the call as cancelled', async () => {
      const openai = vendor({ delayMs: 10_000 });
      const h = setup({ openai });
      const { missionId, runId } = await h.startRun(COOKIES);
      const running = h.engine.execute({ runId });
      for (let i = 0; i < 200 && openai.seen.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
      assert.ok(openai.seen.length > 0, 'a call is in flight');
      assert.equal(await h.engine.cancel(runId), true);
      const outcome = await running;

      assert.equal(outcome.status, 'cancelled');
      assert.ok(openai.seen[0]!.signal?.aborted);
      const audit = await h.audit.forMission(missionId, 2000);
      const cancelled = audit.filter((e) => e.type === 'provider.request_failed');
      assert.ok(cancelled.some((e) => (e.data as any).code === 'PROVIDER_CANCELLED'));
      assert.equal(h.router.circuitState('openai')?.consecutiveFailures ?? 0, 0, 'a cancellation is not the provider failing');
    });

    it('a malformed 200 is an invalid response, retried, and counted against the circuit — never turned into text', async () => {
      const openai = vendor({ body: { id: 'x', choices: [] } });
      const h = setup({ openai });
      const r = await run(h);
      assert.notEqual(r.outcome.status, 'completed');
      const codes = new Set(events(r, 'provider.request_failed').map((e) => e.data.code));
      assert.deepEqual([...codes], ['PROVIDER_INVALID_RESPONSE']);
      assert.equal(r.state.steps.some((s) => s.result !== null), false, 'no result was invented');
    });

    it('a 400 is a bad request: not retried, not counted, the step fails with the reason', async () => {
      const openai = vendor({ status: 400, body: { error: { message: 'Unsupported parameter' } } });
      const h = setup({ openai });
      const r = await run(h);
      const first = r.trace.steps.find((s) => s.providerCalls.length > 0)!;
      assert.equal(first.providerCalls.length, 1, 'no retry of a request that will fail again');
      assert.equal(first.providerError?.code, 'PROVIDER_BAD_REQUEST');
      assert.equal(first.providerError?.retryable, false);
      assert.equal(h.router.circuitState('openai')?.consecutiveFailures ?? 0, 0);
    });

    it('tokens spent on an unusable answer are still recorded: a bad output is not a free call', async () => {
      const short = { id: 'x', choices: [{ message: { role: 'assistant', content: 'No.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1500, completion_tokens: 2, total_tokens: 1502 } };
      const openai = vendor({ body: short });
      const h = setup({ openai });
      const r = await run(h);
      assert.ok(r.costs.length >= 1, 'the calls were billed and are on the ledger');
      assert.ok(r.costs.every((c) => c.provider === 'openai' && c.completionTokens === 2));
      assert.equal(r.state.steps.some((s) => s.result !== null), false);
    });
  });

  describe('failover between real providers', () => {
    it('a provider that fails permanently hands the step to the next real provider — labelled as that provider', async () => {
      // Ties break alphabetically, so Anthropic is tried first; its key is rejected.
      const anthropic = vendor({ status: 401, body: { error: { type: 'authentication_error', message: 'invalid x-api-key' } } });
      const openai = vendor();
      const h = setup({ openai, anthropic });
      const r = await run(h);

      assert.equal(r.outcome.status, 'completed');
      const results = r.state.steps.filter((s) => s.result !== null).map((s) => s.result!);
      assert.ok(results.length >= 8);
      assert.ok(results.every((res) => res.provider === 'openai' && res.source === 'real' && res.simulated === false));
      assert.equal(anthropic.seen.length, 1, 'rejected once, then out of service');
      assert.ok(anthropic.seen[0]!.url.endsWith('/messages') && anthropic.seen[0]!.headers['x-api-key'] === ANT_KEY);
      assert.ok(openai.seen.length >= 8);
      assert.ok(events(r, 'provider.request_failed').some((e) => e.data.provider === 'anthropic' && e.data.code === 'PROVIDER_AUTH_FAILED'));
      assert.ok(events(r, 'route.switched').length >= 1);
      assert.equal(r.state.steps.some((s) => s.result?.provider === 'mock'), false);
    });
  });

  describe('secrets', () => {
    it('no credential appears in the audit log, the cost ledger, the run state, the trace, or any error — even when the vendor echoes it', async () => {
      for (const scenario of [
        vendor(),
        vendor({ status: 401, body: { error: { message: `Incorrect API key provided: ${KEY}. See https://x/?key=${KEY}` } } }),
        vendor({ status: 503, body: { error: { message: `upstream error for ${KEY}` } } }),
      ]) {
        const h = setup({ openai: scenario });
        const r = await run(h);
        const everything = JSON.stringify({ audit: r.audit, costs: r.costs, state: r.state, trace: r.trace, plan: r.plan, outcome: r.outcome, catalog: h.catalog.profiles() });
        assert.equal(everything.includes(KEY), false, 'the full key must not appear');
        assert.equal(everything.includes(KEY.slice(0, 16)), false, 'nor a long prefix of it');
        assert.equal(everything.toLowerCase().includes('bearer sk-'), false);
      }
    });
  });

  describe('provenance integrity', () => {
    it('a result whose provenance contradicts its adapter is refused, not stored', async () => {
      const { ProviderStepRunner } = await import('./runner.ts');
      const { OpenAIProvider } = await import('@acc/providers');
      class Liar extends OpenAIProvider {
        override async execute(task: ProviderTask, signal?: AbortSignal) {
          return { ...(await super.execute(task, signal)), source: 'mock' as const, simulated: true };
        }
      }
      const { fetch } = vendor();
      const liar = new Liar({ apiKey: KEY, models: ['gpt-test'], fetch });
      const lookup = { resolve: () => ({ provider: liar, model: 'gpt-test' }) };
      const runner = new ProviderStepRunner(lookup);
      const h = createEngineHarness({ providerRegistry: createProviderRegistry({ mock: { minLatencyMs: 0, maxLatencyMs: 0 }, openai: { apiKey: KEY, models: ['gpt-test'], fetch } }), runner, prices: PRICES, engine: { parallelism: 1 } });
      const r = await run(h);
      assert.equal(r.state.steps.some((s) => s.result !== null), false, 'nothing was stored as if a model had answered');
      assert.ok(r.state.steps.some((s) => /procedencia incoherente/.test(s.error ?? '') || /procedencia incoherente/.test(s.providerError?.message ?? '')));
    });

    it('results stored before provenance existed are read by their provider id, never guessed', async () => {
      const { provenanceOf } = await import('../util.ts');
      assert.deepEqual(provenanceOf({ provider: 'mock' }), { source: 'mock', simulated: true });
      assert.deepEqual(provenanceOf({ provider: 'openai' }), { source: 'real', simulated: false });
      assert.deepEqual(provenanceOf({ provider: 'openai', source: 'real', simulated: false }), { source: 'real', simulated: false });
    });
  });

  describe('the integrity work still holds', () => {
    it('a run over a real provider survives a restart mid-flight: recovery closes it and nothing stays running', async () => {
      const { RunRecovery } = await import('./recovery.ts');
      const hanging = vendor((_, i) => (i >= 2 ? { delayMs: 60_000 } : {}));
      const h = setup({ openai: hanging });
      const { runId, missionId } = await h.startRun(COOKIES);
      void h.engine.execute({ runId });
      for (let i = 0; i < 400 && hanging.seen.length < 3; i++) await new Promise((r) => setTimeout(r, 5));
      assert.ok(hanging.seen.length >= 3, 'a real call is mid-flight');

      const recovery = new RunRecovery({ repositories: h.repos, store: h.store, audit: h.audit, approvals: h.approvals, cost: h.cost, agents: h.agents, clock: h.clock, isActive: () => false });
      const report = await recovery.recover();
      assert.equal(report.recovered.length, 1);
      const state = (await h.store.get<MadreRunState>(KINDS.runState, runId))!;
      assert.ok(state.steps.every((s) => s.status !== 'RUNNING' && s.status !== 'RETRYING'));
      assert.deepEqual(await recovery.inspect(missionId), []);
      await h.engine.cancel(runId);
    });
  });
});
