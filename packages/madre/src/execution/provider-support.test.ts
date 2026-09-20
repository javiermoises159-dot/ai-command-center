/** Units behind the real-provider path: error → healing policy, provenance guard, secret scrubbing, catalog states, health probe. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ProviderError, type ProviderDescriptor, type ProviderErrorCode, type ProviderId } from '@acc/domain';

import { checkProviderHealth } from '../registry/health.ts';
import { ProviderCatalog } from '../registry/providers.ts';
import { provenanceOf, redactSecrets } from '../util.ts';
import { DEFAULT_HEALING, diagnose } from './healing.ts';
import { assertProvenance } from './runner.ts';
import { ANTHROPIC, MOCK, OLLAMA_MIXED } from '../testing.ts';

const err = (code: ProviderErrorCode, extra: { retryAfterMs?: number; retryable?: boolean } = {}) =>
  new ProviderError(code, { provider: 'openai', model: 'gpt-test', detail: 'detalle en español', ...extra });

describe('healing policy for structured provider errors', () => {
  it('retries transient failures with backoff and switches after the second attempt', () => {
    for (const code of ['PROVIDER_TIMEOUT', 'PROVIDER_RATE_LIMITED', 'PROVIDER_UNAVAILABLE', 'PROVIDER_INVALID_RESPONSE'] as const) {
      const first = diagnose(err(code), 1);
      assert.equal(first.action, 'retry', code);
      assert.equal(first.retryable, true);
      assert.equal(first.switchProvider, false);
      assert.equal(diagnose(err(code), 2).switchProvider, true);
    }
  });

  it('honours Retry-After, but never waits beyond the ceiling', () => {
    assert.equal(diagnose(err('PROVIDER_RATE_LIMITED', { retryAfterMs: 3000 }), 1).backoffMs, 3000);
    assert.equal(diagnose(err('PROVIDER_RATE_LIMITED', { retryAfterMs: 999_000 }), 1).backoffMs, DEFAULT_HEALING.maxBackoffMs);
  });

  it('does not retry a permanent configuration error: it moves to another provider', () => {
    for (const code of ['PROVIDER_AUTH_FAILED', 'PROVIDER_QUOTA_EXHAUSTED'] as const) {
      const d = diagnose(err(code), 1);
      assert.equal(d.action, 'switch_provider', code);
      assert.equal(d.switchProvider, true);
      assert.equal(d.backoffMs, 0);
    }
    assert.equal(diagnose(err('PROVIDER_AUTH_FAILED'), 1).class, 'auth');
    assert.equal(diagnose(err('PROVIDER_QUOTA_EXHAUSTED'), 1).class, 'quota');
  });

  it('does not retry a request that would fail again, nor a refusal', () => {
    assert.equal(diagnose(err('PROVIDER_BAD_REQUEST'), 1).action, 'fail');
    assert.equal(diagnose(err('PROVIDER_CAPABILITY_MISMATCH'), 1).action, 'fail');
    assert.equal(diagnose(err('PROVIDER_INVALID_RESPONSE', { retryable: false }), 1).action, 'fail');
    assert.equal(diagnose(err('PROVIDER_COST_UNKNOWN'), 1).class, 'budget');
  });

  it('treats a cancellation as a stop, not a failure', () => {
    const d = diagnose(err('PROVIDER_CANCELLED'), 1);
    assert.equal(d.action, 'stop');
    assert.equal(d.retryable, false);
  });

  it('classifies errors by their code, not by guessing at their words', () => {
    // The text says "timeout" but the code says it is a bad request: the code wins.
    const d = diagnose(new ProviderError('PROVIDER_BAD_REQUEST', { provider: 'openai', detail: 'timeout timeout 503' }), 1);
    assert.equal(d.class, 'invalid_request');
  });
});

describe('error traits', () => {
  it('only transient, retryable errors count against the circuit; configuration errors are permanent', () => {
    const counts = (c: ProviderErrorCode) => err(c).countsAgainstCircuit;
    assert.deepEqual(['PROVIDER_TIMEOUT', 'PROVIDER_RATE_LIMITED', 'PROVIDER_UNAVAILABLE', 'PROVIDER_INVALID_RESPONSE'].map((c) => counts(c as ProviderErrorCode)), [true, true, true, true]);
    for (const c of ['PROVIDER_AUTH_FAILED', 'PROVIDER_QUOTA_EXHAUSTED', 'PROVIDER_BAD_REQUEST', 'PROVIDER_UNCONFIGURED', 'PROVIDER_CANCELLED', 'PROVIDER_COST_UNKNOWN'] as const) {
      assert.equal(counts(c), false, `${c} must not open a circuit`);
    }
    assert.equal(err('PROVIDER_AUTH_FAILED').permanent, true);
    assert.equal(err('PROVIDER_QUOTA_EXHAUSTED').permanent, true);
    assert.equal(err('PROVIDER_TIMEOUT').permanent, false);
  });

  it('serialises to code, stage, provider, model, retryable, message and cause — with a Spanish message', () => {
    const info = new ProviderError('PROVIDER_TIMEOUT', { provider: 'openai', model: 'gpt-test', detail: 'OpenAI no respondió a tiempo.', cause: 'timeout 5000ms' }).toInfo();
    assert.deepEqual(Object.keys(info).sort(), ['cause', 'code', 'message', 'model', 'provider', 'retryable', 'stage']);
    assert.equal(info.code, 'PROVIDER_TIMEOUT');
    assert.equal(info.message, 'OpenAI no respondió a tiempo.');
    assert.equal(info.retryable, true);
  });
});

describe('provenance guard', () => {
  it('accepts consistent results', () => {
    assertProvenance('mock', { provider: 'mock', source: 'mock', simulated: true });
    assertProvenance('openai', { provider: 'openai', source: 'real', simulated: false });
  });

  it('refuses a real adapter that says mock, a mock that says real, a half-marked result, or another provider id', () => {
    const bad: [string, { provider: ProviderId; source: 'real' | 'mock'; simulated: boolean }][] = [
      ['openai', { provider: 'openai', source: 'mock', simulated: true }],
      ['mock', { provider: 'mock', source: 'real', simulated: false }],
      ['openai', { provider: 'openai', source: 'real', simulated: true }],
      ['openai', { provider: 'openai', source: 'mock', simulated: false }],
      ['openai', { provider: 'anthropic', source: 'real', simulated: false }],
    ];
    for (const [id, r] of bad) assert.throws(() => assertProvenance(id, r), /incoherente|Provenance mismatch/, JSON.stringify([id, r]));
  });

  it('reads a result stored before provenance existed from its provider id', () => {
    assert.deepEqual(provenanceOf({ provider: 'mock' }), { source: 'mock', simulated: true });
    assert.deepEqual(provenanceOf({ provider: 'gemini' }), { source: 'real', simulated: false });
  });
});

describe('redactSecrets', () => {
  it('scrubs the credential shapes of the three vendors, bearer headers and key query params', () => {
    const text = [
      'sk-proj-ABCDEFGHIJKLMNOP1234',
      'sk-ant-api03-ABCDEFGHIJKLMNOP1234',
      'AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ012345',
      'Authorization: Bearer abcdefghijklmnop123',
      'https://x.test/v1?key=SECRETVALUE123&alt=json',
    ].join('\n');
    const out = redactSecrets(text);
    for (const leaked of ['ABCDEFGHIJKLMNOP', 'AIzaSy', 'abcdefghijklmnop123', 'SECRETVALUE123']) assert.equal(out.includes(leaked), false, leaked);
    assert.match(out, /alt=json/, 'the rest of the text survives');
  });

  it('leaves ordinary text alone', () => {
    assert.equal(redactSecrets('Una cookie es un archivo pequeño.'), 'Una cookie es un archivo pequeño.');
  });
});

describe('provider catalog states', () => {
  const describeAll = (): ProviderDescriptor[] => [
    { id: 'openai', label: 'OpenAI', availability: 'unconfigured', models: [], implemented: true, configured: false, requires: ['OPENAI_API_KEY', 'OPENAI_MODEL'] },
    { ...ANTHROPIC, implemented: true, configured: true },
    MOCK,
    OLLAMA_MIXED,
  ];

  it('separates implemented / configured / available / enabled / healthy, and never mistakes a key for health', () => {
    const catalog = new ProviderCatalog(describeAll);
    const openai = catalog.get('openai')!;
    assert.equal(openai.status, 'UNCONFIGURED');
    assert.equal(openai.configured, false);
    assert.equal(openai.available, false);
    assert.equal(openai.executable, false);

    const anthropic = catalog.get('anthropic')!;
    assert.equal(anthropic.configured, true);
    assert.equal(anthropic.executable, true);
    assert.equal(anthropic.healthy, null, 'configured is not healthy: nothing has probed it yet');
    assert.equal(anthropic.source, 'real');
    assert.equal(catalog.get('mock')!.source, 'mock');
  });

  it('a healthy or down probe changes `healthy`, not `configured`', () => {
    const catalog = new ProviderCatalog(describeAll);
    const at = new Date().toISOString();
    catalog.recordHealth('anthropic', { status: 'ok', checkedAt: at, latencyMs: 10, detail: 'ok' });
    assert.equal(catalog.get('anthropic')!.healthy, true);
    catalog.recordHealth('anthropic', { status: 'down', checkedAt: at, latencyMs: 10, detail: 'caído' });
    assert.equal(catalog.get('anthropic')!.healthy, false);
    assert.equal(catalog.get('anthropic')!.configured, true);
  });

  it('a disabled provider is DISABLED, not executable and not enabled; enabling restores it', () => {
    const catalog = new ProviderCatalog(describeAll);
    catalog.disable('anthropic', 'MADRE_DISABLED_PROVIDERS');
    const disabled = catalog.get('anthropic')!;
    assert.equal(disabled.status, 'DISABLED');
    assert.equal(disabled.enabled, false);
    assert.equal(disabled.executable, false);
    catalog.enable('anthropic');
    assert.equal(catalog.get('anthropic')!.enabled, true);
    assert.equal(catalog.get('anthropic')!.executable, true);
  });
});

describe('adapter health probe', () => {
  it('uses the adapter probe result for a configured real provider — including down', async () => {
    const p = { id: 'openai', executable: true, tier: 'external' as const };
    const down = await checkProviderHealth(p, { probe: async () => ({ status: 'down', detail: 'HTTP 503', latencyMs: 12 }) });
    assert.equal(down.status, 'down');
    assert.equal(down.latencyMs, 12);
    const ok = await checkProviderHealth(p, { probe: async () => ({ status: 'ok', detail: 'responde', latencyMs: 5 }) });
    assert.equal(ok.status, 'ok');
  });

  it('never probes an unconfigured provider: there is no key to send', async () => {
    let probed = false;
    const health = await checkProviderHealth({ id: 'openai', executable: false, tier: 'external' }, { probe: async () => { probed = true; return null; } });
    assert.equal(health.status, 'not_connected');
    assert.equal(probed, false);
  });
});
