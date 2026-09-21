/**
 * The real adapters, tested at the HTTP level with a fake `fetch`.
 *
 * Nothing here needs a credential or a network. What is proven: the request
 * each vendor is sent, how its answer is read, how every kind of failure is
 * classified, that a missing key is `unconfigured` (never a simulation), that
 * no credential leaks into anything reported, and that no adapter retries on
 * its own.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ProviderError, type ProviderTask } from '@acc/domain';

import { createProviderRegistry } from '../index.ts';
import { realProviderOptionsFromEnv } from './env.ts';
import { AnthropicProvider } from './anthropic.ts';
import { FAKE_KEYS, TEXT, anthropicOk, fakeFetch, geminiOk, openaiOk, type FakeReply } from './fixtures.test-support.ts';
import { GeminiProvider } from './gemini.ts';
import { OpenAIProvider } from './openai.ts';
import type { RealProvider, RealProviderOptions } from './real-provider.ts';

function task(overrides: Partial<ProviderTask> = {}): ProviderTask {
  return { agentId: 'strategy', systemPrompt: 'Eres el agente de estrategia.', prompt: 'Explica en una frase qué es una cookie.', model: 'm-1', ...overrides };
}

interface Vendor {
  name: string;
  id: 'openai' | 'anthropic' | 'gemini';
  key: string;
  keyVariable: string;
  modelVariable: string;
  make(options: RealProviderOptions): RealProvider;
  ok(text?: string): unknown;
  /** Where a completion is POSTed. */
  path(model: string): string;
  /** How the credential travels. */
  authHeader: string;
  /** A body the vendor answers with when the model is unknown. */
  quotaBody: unknown;
  refusal: unknown;
  emptyBody: unknown;
}

const VENDORS: Vendor[] = [
  {
    name: 'OpenAI',
    id: 'openai',
    key: FAKE_KEYS.openai,
    keyVariable: 'OPENAI_API_KEY',
    modelVariable: 'OPENAI_MODEL',
    make: (o) => new OpenAIProvider(o),
    ok: openaiOk,
    path: () => '/chat/completions',
    authHeader: 'authorization',
    quotaBody: { error: { message: 'You exceeded your current quota, please check your plan and billing details.', type: 'insufficient_quota', code: 'insufficient_quota' } },
    refusal: { id: 'x', choices: [{ message: { role: 'assistant', content: null, refusal: 'No puedo ayudar con eso.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
    emptyBody: { id: 'x', choices: [] },
  },
  {
    name: 'Anthropic',
    id: 'anthropic',
    key: FAKE_KEYS.anthropic,
    keyVariable: 'ANTHROPIC_API_KEY',
    modelVariable: 'ANTHROPIC_MODEL',
    make: (o) => new AnthropicProvider(o),
    ok: anthropicOk,
    path: () => '/messages',
    authHeader: 'x-api-key',
    quotaBody: { type: 'error', error: { type: 'billing_error', message: 'Your credit balance is too low to access the Anthropic API.' } },
    refusal: { id: 'm', content: [], stop_reason: 'refusal', usage: { input_tokens: 1, output_tokens: 0 } },
    emptyBody: { id: 'm', type: 'message' },
  },
  {
    name: 'Gemini',
    id: 'gemini',
    key: FAKE_KEYS.google,
    keyVariable: 'GOOGLE_API_KEY',
    modelVariable: 'GEMINI_MODEL',
    make: (o) => new GeminiProvider(o),
    ok: geminiOk,
    path: (model) => `/models/${model}:generateContent`,
    authHeader: 'x-goog-api-key',
    quotaBody: { error: { code: 429, message: 'You exceeded your current quota, please check your plan and billing details.', status: 'RESOURCE_EXHAUSTED' } },
    refusal: { promptFeedback: { blockReason: 'SAFETY' }, usageMetadata: { promptTokenCount: 1 } },
    emptyBody: {},
  },
];

async function failureOf(vendor: Vendor, reply: FakeReply, options: Partial<RealProviderOptions> = {}, t: Partial<ProviderTask> = {}): Promise<ProviderError> {
  const { fetch } = fakeFetch(reply);
  const provider = vendor.make({ apiKey: vendor.key, models: ['m-1'], fetch, ...options });
  try {
    await provider.execute(task(t));
  } catch (error) {
    assert.ok(error instanceof ProviderError, `expected a ProviderError, got ${String(error)}`);
    return error;
  }
  assert.fail('expected the call to fail');
}

for (const vendor of VENDORS) {
  describe(`${vendor.name} adapter`, () => {
    describe('configuration', () => {
      it('is unconfigured without a key, and says which variable is missing', () => {
        const p = vendor.make({ models: ['m-1'] });
        assert.equal(p.availability, 'unconfigured');
        const c = p.configuration();
        assert.equal(c.configured, false);
        assert.match(c.reason ?? '', new RegExp(vendor.keyVariable));
        assert.doesNotMatch(c.reason ?? '', new RegExp(vendor.modelVariable));
        assert.deepEqual(p.listModels(), []);
      });

      it('is unconfigured without a model, even with a key', () => {
        const p = vendor.make({ apiKey: vendor.key });
        assert.equal(p.availability, 'unconfigured');
        assert.match(p.configuration().reason ?? '', new RegExp(vendor.modelVariable));
      });

      it('treats a blank key as missing', () => {
        assert.equal(vendor.make({ apiKey: '   ', models: ['m-1'] }).availability, 'unconfigured');
      });

      it('is available with a key and a model, declares only what it implements, and never holds the key in its description', () => {
        const p = vendor.make({ apiKey: vendor.key, models: ['m-1', 'm-2'] });
        assert.equal(p.availability, 'available');
        assert.deepEqual(p.listModels().map((m) => m.id), ['m-1', 'm-2']);
        for (const m of p.listModels()) {
          assert.deepEqual(m.capabilities, { streaming: false, toolCalling: false, structuredOutput: false, embeddings: false, vision: false });
        }
        assert.equal(JSON.stringify([p.configuration(), p.listModels()]).includes(vendor.key), false);
      });
    });

    describe('when unconfigured', () => {
      it('refuses to execute with PROVIDER_UNCONFIGURED and makes no request — it never answers with a simulation', async () => {
        const { fetch, requests } = fakeFetch({ body: vendor.ok() });
        const p = vendor.make({ models: ['m-1'], fetch });
        await assert.rejects(p.execute(task()), (error: unknown) => {
          assert.ok(error instanceof ProviderError);
          assert.equal(error.providerCode, 'PROVIDER_UNCONFIGURED');
          assert.equal(error.stage, 'config');
          assert.equal(error.retryable, false);
          assert.equal(error.permanent, true);
          assert.equal(error.countsAgainstCircuit, false);
          assert.match(error.publicMessage, new RegExp(vendor.keyVariable));
          return true;
        });
        assert.equal(requests.length, 0);
      });

      it('reports not_connected — not healthy, not down — without a request', async () => {
        const { fetch, requests } = fakeFetch({ body: {} });
        const report = await vendor.make({ models: ['m-1'], fetch }).health!();
        assert.equal(report.status, 'not_connected');
        assert.equal(requests.length, 0);
      });
    });

    describe('a successful call', () => {
      it('sends the credential in a header, the prompts in the body, and reads text, usage and ids', async () => {
        const { fetch, requests } = fakeFetch({ body: vendor.ok(), headers: { 'x-request-id': 'req_abc', 'request-id': 'req_abc' } });
        const p = vendor.make({ apiKey: vendor.key, models: ['m-1'], fetch });
        const result = await p.execute(task({ maxTokens: 300, temperature: 0.2 }));

        assert.equal(requests.length, 1);
        const sent = requests[0]!;
        assert.equal(sent.method, 'POST');
        assert.ok(sent.url.endsWith(vendor.path('m-1')), sent.url);
        assert.equal(sent.headers[vendor.authHeader]?.includes(vendor.key), true, 'the key is sent in its header');
        assert.equal(sent.url.includes(vendor.key), false, 'the key is never in the URL');
        assert.ok(JSON.stringify(sent.body).includes('Eres el agente de estrategia.'));
        assert.ok(JSON.stringify(sent.body).includes('Explica en una frase qué es una cookie.'));
        assert.equal(JSON.stringify(sent.body).includes(vendor.key), false, 'the key is never in the body');

        assert.equal(result.provider, vendor.id);
        assert.equal(result.model, 'm-1');
        assert.equal(result.text, TEXT);
        assert.deepEqual(result.usage, { promptTokens: 120, completionTokens: 30, totalTokens: 150 });
        assert.equal(result.finishReason, 'stop');
        assert.ok(result.requestId.length > 0);
        assert.ok(result.latencyMs >= 0);
        // Provenance: a model really answered.
        assert.equal(result.source, 'real');
        assert.equal(result.simulated, false);
      });

      it('makes exactly one request per call: the adapter does not retry on its own', async () => {
        const counted = fakeFetch({ status: 503, body: { error: { message: 'overloaded' } } });
        const p = vendor.make({ apiKey: vendor.key, models: ['m-1'], fetch: counted.fetch });
        await assert.rejects(p.execute(task()), (error: unknown) => error instanceof ProviderError && error.providerCode === 'PROVIDER_UNAVAILABLE');
        assert.equal(counted.requests.length, 1, 'the engine owns retries; a second loop here would multiply attempts');
      });
    });

    describe('request refusals before any HTTP', () => {
      it('rejects a task that needs a capability the adapter does not implement (PROVIDER_CAPABILITY_MISMATCH)', async () => {
        const { fetch, requests } = fakeFetch({ body: vendor.ok() });
        const p = vendor.make({ apiKey: vendor.key, models: ['m-1'], fetch });
        await assert.rejects(p.execute(task({ requires: ['toolCalling'] })), (error: unknown) => {
          assert.ok(error instanceof ProviderError);
          assert.equal(error.providerCode, 'PROVIDER_CAPABILITY_MISMATCH');
          assert.equal(error.stage, 'capability');
          assert.equal(error.retryable, false);
          return true;
        });
        assert.equal(requests.length, 0);
      });

      it('rejects a model the operator did not enable, instead of spending money on it', async () => {
        const { fetch, requests } = fakeFetch({ body: vendor.ok() });
        const p = vendor.make({ apiKey: vendor.key, models: ['m-1'], fetch });
        await assert.rejects(p.execute(task({ model: 'something-else' })), (error: unknown) => {
          assert.ok(error instanceof ProviderError);
          assert.equal(error.providerCode, 'PROVIDER_BAD_REQUEST');
          assert.match(error.publicMessage, new RegExp(vendor.modelVariable));
          return true;
        });
        assert.equal(requests.length, 0);
      });
    });

    describe('failures are structured, classified and never leak the key', () => {
      const cases: [string, FakeReply, string, { retryable: boolean; circuit: boolean; permanent: boolean }][] = [
        ['401 → auth failed', { status: 401, body: { error: { message: 'Incorrect API key' } } }, 'PROVIDER_AUTH_FAILED', { retryable: false, circuit: false, permanent: true }],
        ['403 → auth failed', { status: 403, body: { error: { message: 'forbidden' } } }, 'PROVIDER_AUTH_FAILED', { retryable: false, circuit: false, permanent: true }],
        ['429 → rate limited', { status: 429, body: { error: { message: 'Too many requests' } } }, 'PROVIDER_RATE_LIMITED', { retryable: true, circuit: true, permanent: false }],
        ['500 → unavailable', { status: 500, body: { error: { message: 'boom' } } }, 'PROVIDER_UNAVAILABLE', { retryable: true, circuit: true, permanent: false }],
        ['503 → unavailable', { status: 503, body: { error: { message: 'overloaded' } } }, 'PROVIDER_UNAVAILABLE', { retryable: true, circuit: true, permanent: false }],
        ['504 → timeout', { status: 504, raw: 'gateway timeout' }, 'PROVIDER_TIMEOUT', { retryable: true, circuit: true, permanent: false }],
        ['400 → bad request', { status: 400, body: { error: { message: 'invalid' } } }, 'PROVIDER_BAD_REQUEST', { retryable: false, circuit: false, permanent: false }],
        ['422 → bad request', { status: 422, body: { error: { message: 'unprocessable' } } }, 'PROVIDER_BAD_REQUEST', { retryable: false, circuit: false, permanent: false }],
        ['404 → unknown model, switch provider', { status: 404, body: { error: { message: 'model not found' } } }, 'PROVIDER_UNCONFIGURED', { retryable: false, circuit: false, permanent: true }],
        ['410 → retired model, switch provider', { status: 410, body: { error: { message: 'gone' } } }, 'PROVIDER_UNCONFIGURED', { retryable: false, circuit: false, permanent: true }],
        ['a dropped connection → unavailable', { networkError: 'fetch failed' }, 'PROVIDER_UNAVAILABLE', { retryable: true, circuit: true, permanent: false }],
        ['a body that is not JSON → invalid response', { raw: '<html>gateway</html>' }, 'PROVIDER_INVALID_RESPONSE', { retryable: true, circuit: true, permanent: false }],
        ['a JSON body without the answer → invalid response', { body: vendor.emptyBody }, 'PROVIDER_INVALID_RESPONSE', { retryable: true, circuit: true, permanent: false }],
        ['a refusal → invalid response, not retryable', { body: vendor.refusal }, 'PROVIDER_INVALID_RESPONSE', { retryable: false, circuit: false, permanent: false }],
      ];
      for (const [name, reply, code, traits] of cases) {
        it(name, async () => {
          const error = await failureOf(vendor, reply);
          assert.equal(error.providerCode, code);
          assert.equal(error.retryable, traits.retryable);
          assert.equal(error.countsAgainstCircuit, traits.circuit);
          assert.equal(error.permanent, traits.permanent);
          assert.equal(error.provider, vendor.id);
          assert.equal(error.model, 'm-1');
          // The structured form is complete, in Spanish, and safe to store.
          const info = error.toInfo();
          assert.equal(info.code, code);
          assert.ok(info.message.length > 0);
          assert.ok(info.stage.length > 0);
        });
      }

      it('an exhausted quota is permanent, not a rate limit that heals', async () => {
        const error = await failureOf(vendor, { status: 429, body: vendor.quotaBody });
        assert.equal(error.providerCode, 'PROVIDER_QUOTA_EXHAUSTED');
        assert.equal(error.permanent, true);
        assert.equal(error.countsAgainstCircuit, false);
      });

      it('a 402 (payment required) is an exhausted quota, so the engine switches provider', async () => {
        const error = await failureOf(vendor, { status: 402, body: { error: { message: 'payment required' } } });
        assert.equal(error.providerCode, 'PROVIDER_QUOTA_EXHAUSTED');
      });

      it('an exhausted balance reported as a 400 (Anthropic) is also permanent, not a bad request', async () => {
        const error = await failureOf(vendor, { status: 400, body: vendor.quotaBody });
        assert.equal(error.providerCode, 'PROVIDER_QUOTA_EXHAUSTED');
      });

      it('carries the vendor\'s Retry-After on a rate limit', async () => {
        const error = await failureOf(vendor, { status: 429, body: { error: { message: 'slow down' } }, headers: { 'retry-after': '7' } });
        assert.equal(error.providerCode, 'PROVIDER_RATE_LIMITED');
        assert.equal(error.retryAfterMs, 7000);
      });

      it('scrubs the key out of a vendor error that echoes it', async () => {
        const echo = `Incorrect API key provided: ${vendor.key}. Also see ${vendor.key.slice(0, 12)}…`;
        const error = await failureOf(vendor, { status: 401, body: { error: { message: echo } } });
        const everything = JSON.stringify({ message: error.message, publicMessage: error.publicMessage, info: error.toInfo(), cause: error.causeText, stack: error.stack });
        assert.equal(everything.includes(vendor.key), false, 'the full key must not appear');
        assert.equal(everything.includes(vendor.key.slice(0, 14)), false, 'not even a long prefix of it');
      });

      it('scrubs the key out of a network error message', async () => {
        const error = await failureOf(vendor, { networkError: `connect ECONNREFUSED while sending ${vendor.key}` });
        assert.equal(JSON.stringify(error.toInfo()).includes(vendor.key), false);
      });

      it('times out on its own clock (PROVIDER_TIMEOUT) and aborts the request', async () => {
        const { fetch, requests } = fakeFetch({ delayMs: 5_000, body: vendor.ok() });
        const p = vendor.make({ apiKey: vendor.key, models: ['m-1'], fetch, timeoutMs: 25 });
        const started = Date.now();
        await assert.rejects(p.execute(task()), (error: unknown) => {
          assert.ok(error instanceof ProviderError);
          assert.equal(error.providerCode, 'PROVIDER_TIMEOUT');
          assert.equal(error.retryable, true);
          return true;
        });
        assert.ok(Date.now() - started < 2_000);
        assert.equal(requests[0]?.signal?.aborted, true, 'the in-flight request was aborted');
      });

      it('honours the caller\'s cancellation (PROVIDER_CANCELLED) and forwards it to the request', async () => {
        const { fetch, requests } = fakeFetch({ delayMs: 5_000, body: vendor.ok() });
        const p = vendor.make({ apiKey: vendor.key, models: ['m-1'], fetch });
        const controller = new AbortController();
        const pending = p.execute(task(), controller.signal);
        setTimeout(() => controller.abort(), 10);
        await assert.rejects(pending, (error: unknown) => {
          assert.ok(error instanceof ProviderError);
          assert.equal(error.providerCode, 'PROVIDER_CANCELLED');
          return true;
        });
        assert.equal(requests[0]?.signal?.aborted, true);
      });

      it('does not even send a request when already cancelled', async () => {
        const { fetch, requests } = fakeFetch({ body: vendor.ok() });
        const p = vendor.make({ apiKey: vendor.key, models: ['m-1'], fetch });
        const controller = new AbortController();
        controller.abort();
        await assert.rejects(p.execute(task(), controller.signal), (error: unknown) => error instanceof ProviderError && error.providerCode === 'PROVIDER_CANCELLED');
        assert.equal(requests.length, 0);
      });
    });

    describe('health probe', () => {
      it('is ok only after the vendor answered a success, and is never a billed call', async () => {
        const { fetch, requests } = fakeFetch({ body: { data: [], models: [] } });
        const report = await vendor.make({ apiKey: vendor.key, models: ['m-1'], fetch }).health!();
        assert.equal(report.status, 'ok');
        assert.equal(requests.length, 1);
        assert.equal(requests[0]!.method, 'GET', 'a listing, not a generation');
        assert.equal(requests[0]!.url.includes(vendor.key), false);
      });

      it('is down (not ok, not thrown) when the key is rejected, and the message hides the key', async () => {
        const { fetch } = fakeFetch({ status: 401, body: { error: { message: `bad key ${vendor.key}` } } });
        const report = await vendor.make({ apiKey: vendor.key, models: ['m-1'], fetch }).health!();
        assert.equal(report.status, 'down');
        assert.equal(report.detail.includes(vendor.key), false);
      });

      it('is down when the vendor cannot be reached', async () => {
        const { fetch } = fakeFetch({ networkError: 'ENOTFOUND' });
        assert.equal((await vendor.make({ apiKey: vendor.key, models: ['m-1'], fetch }).health!()).status, 'down');
      });
    });
  });
}

describe('vendor-specific request shapes', () => {
  it('OpenAI: chat completions with a bearer token, max_completion_tokens, and temperature only when set', async () => {
    const { fetch, requests } = fakeFetch({ body: openaiOk() });
    const p = new OpenAIProvider({ apiKey: FAKE_KEYS.openai, models: ['gpt-test'], fetch });
    await p.execute(task({ model: 'gpt-test' }));
    await p.execute(task({ model: 'gpt-test', maxTokens: 200, temperature: 0.5 }));
    const [plain, tuned] = requests.map((r) => r.body as Record<string, unknown>);
    assert.equal(requests[0]!.url, 'https://api.openai.com/v1/chat/completions');
    assert.equal(requests[0]!.headers['authorization'], `Bearer ${FAKE_KEYS.openai}`);
    assert.deepEqual(plain!['messages'], [{ role: 'system', content: 'Eres el agente de estrategia.' }, { role: 'user', content: 'Explica en una frase qué es una cookie.' }]);
    assert.equal('temperature' in plain!, false);
    assert.equal('max_completion_tokens' in plain!, false);
    assert.equal(tuned!['max_completion_tokens'], 200);
    assert.equal(tuned!['temperature'], 0.5);
  });

  it('OpenAI: reads the request id from the header, else from the body id', async () => {
    const withHeader = fakeFetch({ body: openaiOk(), headers: { 'x-request-id': 'req_header' } });
    assert.equal((await new OpenAIProvider({ apiKey: FAKE_KEYS.openai, models: ['m'], fetch: withHeader.fetch }).execute(task({ model: 'm' }))).requestId, 'req_header');
    const withoutHeader = fakeFetch({ body: openaiOk() });
    assert.equal((await new OpenAIProvider({ apiKey: FAKE_KEYS.openai, models: ['m'], fetch: withoutHeader.fetch }).execute(task({ model: 'm' }))).requestId, 'chatcmpl-abc123');
  });

  it('OpenAI: maps finish reasons', async () => {
    for (const [given, expected] of [['length', 'length'], ['content_filter', 'content_filter'], ['tool_calls', 'other']] as const) {
      const body = openaiOk();
      body.choices[0]!.finish_reason = given;
      const { fetch } = fakeFetch({ body });
      assert.equal((await new OpenAIProvider({ apiKey: FAKE_KEYS.openai, models: ['m'], fetch }).execute(task({ model: 'm' }))).finishReason, expected);
    }
  });

  it('OpenAI: a base URL override is honoured (a gateway or proxy)', async () => {
    const { fetch, requests } = fakeFetch({ body: openaiOk() });
    await new OpenAIProvider({ apiKey: FAKE_KEYS.openai, models: ['m'], fetch, baseUrl: 'https://gateway.example/v1/' }).execute(task({ model: 'm' }));
    assert.equal(requests[0]!.url, 'https://gateway.example/v1/chat/completions');
  });

  it('Anthropic: messages API with x-api-key, the version header and a mandatory max_tokens', async () => {
    const { fetch, requests } = fakeFetch({ body: anthropicOk(), headers: { 'request-id': 'req_ant' } });
    const p = new AnthropicProvider({ apiKey: FAKE_KEYS.anthropic, models: ['claude-test'], fetch });
    const result = await p.execute(task({ model: 'claude-test' }));
    const sent = requests[0]!;
    assert.equal(sent.url, 'https://api.anthropic.com/v1/messages');
    assert.equal(sent.headers['x-api-key'], FAKE_KEYS.anthropic);
    assert.equal(sent.headers['anthropic-version'], '2023-06-01');
    const body = sent.body as Record<string, unknown>;
    assert.equal(body['system'], 'Eres el agente de estrategia.');
    assert.deepEqual(body['messages'], [{ role: 'user', content: 'Explica en una frase qué es una cookie.' }]);
    assert.equal(body['max_tokens'], 4096, 'the API requires one, so a default is sent');
    assert.equal(result.requestId, 'req_ant');
    assert.equal(result.finishReason, 'stop');
  });

  it('Anthropic: max_tokens comes from the task, then the adapter option', async () => {
    const { fetch, requests } = fakeFetch({ body: anthropicOk() });
    const p = new AnthropicProvider({ apiKey: FAKE_KEYS.anthropic, models: ['c'], fetch, maxOutputTokens: 1000 });
    await p.execute(task({ model: 'c' }));
    await p.execute(task({ model: 'c', maxTokens: 50 }));
    assert.deepEqual(requests.map((r) => (r.body as Record<string, unknown>)['max_tokens']), [1000, 50]);
  });

  it('Anthropic: joins text blocks, maps stop_reason=max_tokens to length', async () => {
    const body = { ...anthropicOk(), content: [{ type: 'text', text: 'Hola ' }, { type: 'tool_use', id: 't', name: 'x', input: {} }, { type: 'text', text: 'mundo' }], stop_reason: 'max_tokens' };
    const { fetch } = fakeFetch({ body });
    const result = await new AnthropicProvider({ apiKey: FAKE_KEYS.anthropic, models: ['c'], fetch }).execute(task({ model: 'c' }));
    assert.equal(result.text, 'Hola mundo');
    assert.equal(result.finishReason, 'length');
  });

  it('Anthropic: the endpoint is NOT read from ANTHROPIC_BASE_URL (another tool\'s setting)', () => {
    const options = realProviderOptionsFromEnv({ ANTHROPIC_API_KEY: 'k'.repeat(10), ANTHROPIC_MODEL: 'c', ANTHROPIC_BASE_URL: 'https://someone-elses-proxy.example' });
    assert.equal(options.anthropic.baseUrl, undefined);
  });

  it('Gemini: generateContent with the key in a header (never the URL) and a systemInstruction', async () => {
    const { fetch, requests } = fakeFetch({ body: geminiOk() });
    const p = new GeminiProvider({ apiKey: FAKE_KEYS.google, models: ['gemini-test'], fetch });
    const result = await p.execute(task({ model: 'gemini-test', maxTokens: 64 }));
    const sent = requests[0]!;
    assert.equal(sent.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent');
    assert.equal(sent.headers['x-goog-api-key'], FAKE_KEYS.google);
    const body = sent.body as Record<string, any>;
    assert.equal(body['systemInstruction'].parts[0].text, 'Eres el agente de estrategia.');
    assert.equal(body['contents'][0].parts[0].text, 'Explica en una frase qué es una cookie.');
    assert.equal(body['generationConfig'].maxOutputTokens, 64);
    assert.equal(result.requestId, 'resp-xyz');
  });

  it('Gemini: accepts a "models/"-prefixed model id, counts reasoning tokens as output, drops thought parts', async () => {
    const body = {
      candidates: [{ content: { parts: [{ text: 'pensando…', thought: true }, { text: 'La respuesta.' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 20 },
    };
    const { fetch, requests } = fakeFetch({ body });
    const result = await new GeminiProvider({ apiKey: FAKE_KEYS.google, models: ['models/gemini-x'], fetch }).execute(task({ model: 'models/gemini-x' }));
    assert.ok(requests[0]!.url.endsWith('/models/gemini-x:generateContent'));
    assert.equal(result.text, 'La respuesta.');
    assert.deepEqual(result.usage, { promptTokens: 10, completionTokens: 25, totalTokens: 35 });
  });

  it('Gemini: a safety stop is an invalid response that is not retried', async () => {
    const body = { candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: 'SAFETY' }], usageMetadata: { promptTokenCount: 1 } };
    const { fetch } = fakeFetch({ body });
    await assert.rejects(new GeminiProvider({ apiKey: FAKE_KEYS.google, models: ['g'], fetch }).execute(task({ model: 'g' })), (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.providerCode, 'PROVIDER_INVALID_RESPONSE');
      assert.equal(error.retryable, false);
      return true;
    });
  });
});

describe('environment mapping', () => {
  it('reads the documented variables, trims blanks and splits a model list', () => {
    const options = realProviderOptionsFromEnv({
      OPENAI_API_KEY: ' sk-a ',
      OPENAI_MODEL: 'gpt-a, gpt-b ,',
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_MODEL: 'claude-a',
      GOOGLE_API_KEY: 'g-key',
      GEMINI_MODEL: 'gemini-a',
    });
    assert.equal(options.openai.apiKey, 'sk-a');
    assert.deepEqual(options.openai.models, ['gpt-a', 'gpt-b']);
    assert.equal(options.anthropic.apiKey, undefined, 'a blank variable is unset');
    assert.deepEqual(options.anthropic.models, ['claude-a']);
    assert.equal(options.gemini.apiKey, 'g-key');
  });

  it('accepts GEMINI_API_KEY as an alias, with GOOGLE_API_KEY taking precedence', () => {
    assert.equal(realProviderOptionsFromEnv({ GEMINI_API_KEY: 'old' }).gemini.apiKey, 'old');
    assert.equal(realProviderOptionsFromEnv({ GEMINI_API_KEY: 'old', GOOGLE_API_KEY: 'new' }).gemini.apiKey, 'new');
  });

  it('has no built-in model: nothing configured means unconfigured', () => {
    const options = realProviderOptionsFromEnv({});
    assert.deepEqual([options.openai.models, options.anthropic.models, options.gemini.models], [[], [], []]);
    const registry = createProviderRegistry({ openai: options.openai, anthropic: options.anthropic, gemini: options.gemini });
    assert.deepEqual(registry.availableIds(), ['mock']);
  });

  it('rejects a malformed ANTHROPIC_MAX_TOKENS instead of ignoring it', () => {
    assert.throws(() => realProviderOptionsFromEnv({ ANTHROPIC_MAX_TOKENS: 'lots' }), /ANTHROPIC_MAX_TOKENS/);
    assert.throws(() => realProviderOptionsFromEnv({ ANTHROPIC_MAX_TOKENS: '0' }), /ANTHROPIC_MAX_TOKENS/);
  });
});

describe('registry with real adapters', () => {
  it('lists configured, unconfigured and available as different things', () => {
    const registry = createProviderRegistry({ openai: { apiKey: FAKE_KEYS.openai, models: ['gpt-test'] }, anthropic: { apiKey: FAKE_KEYS.anthropic } });
    const byId = Object.fromEntries(registry.describe().map((d) => [d.id, d]));
    assert.deepEqual([byId['openai']!.availability, byId['openai']!.configured, byId['openai']!.implemented], ['available', true, true]);
    assert.deepEqual([byId['anthropic']!.availability, byId['anthropic']!.configured], ['unconfigured', false], 'a key without a model is not configured');
    assert.deepEqual([byId['gemini']!.availability, byId['gemini']!.configured], ['unconfigured', false]);
    assert.deepEqual([byId['openai-compatible']!.availability, byId['openai-compatible']!.implemented], ['unconfigured', true]);
    assert.deepEqual(registry.availableIds().sort(), ['mock', 'openai']);
  });

  it('never resolves an unconfigured provider to the mock', () => {
    const registry = createProviderRegistry({ openai: { apiKey: FAKE_KEYS.openai, models: ['gpt-test'] } });
    assert.throws(() => registry.resolve('anthropic'), (error: unknown) => error instanceof ProviderError && error.providerCode === 'PROVIDER_UNCONFIGURED' && /ANTHROPIC_API_KEY/.test(error.publicMessage));
    assert.equal(registry.resolve('openai').provider.id, 'openai');
    assert.equal(registry.resolve('openai', 'gpt-test').model, 'gpt-test');
    assert.throws(() => registry.resolve('openai', 'gpt-other'), (error: unknown) => error instanceof Error && /gpt-test/.test((error as { publicMessage?: string }).publicMessage ?? ''));
  });

  it('keeps the mock as the default: a key does not silently reroute classic callers', () => {
    assert.equal(createProviderRegistry({ openai: { apiKey: FAKE_KEYS.openai, models: ['gpt-test'] } }).defaultProviderId(), 'mock');
  });

  it('probes an adapter through the registry, and reports null for one with none', async () => {
    const { fetch } = fakeFetch({ body: { data: [] } });
    const registry = createProviderRegistry({ openai: { apiKey: FAKE_KEYS.openai, models: ['gpt-test'], fetch } });
    assert.equal((await registry.probe('openai'))?.status, 'ok');
    assert.equal((await registry.probe('anthropic'))?.status, 'not_connected');
    assert.equal(await registry.probe('ollama'), null, 'Ollama has no probe of its own here');
    assert.equal(await registry.probe('unknown-id'), null);
  });

  it('labels the simulation as simulated, and a real result as real — the two never swap', async () => {
    const { fetch } = fakeFetch({ body: openaiOk() });
    const registry = createProviderRegistry({ mock: { minLatencyMs: 0, maxLatencyMs: 0 }, openai: { apiKey: FAKE_KEYS.openai, models: ['gpt-test'], fetch } });
    const mock = await registry.resolve('mock').provider.execute(task({ model: 'mock-1' }));
    const real = await registry.resolve('openai').provider.execute(task({ model: 'gpt-test' }));
    assert.deepEqual([mock.provider, mock.source, mock.simulated], ['mock', 'mock', true]);
    assert.deepEqual([real.provider, real.source, real.simulated], ['openai', 'real', false]);
  });
});
