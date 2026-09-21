import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { loadConfig } from './config.ts';

const base: NodeJS.ProcessEnv = { PERSISTENCE: 'memory' };

describe('loadConfig', () => {
  it('applies documented defaults', () => {
    const config = loadConfig(base);
    assert.equal(config.port, 3001);
    assert.equal(config.queueConcurrency, 1);
    assert.equal(config.continueOnWorkerFailure, true);
    assert.equal(config.agentTimeoutMs, 60_000);
    assert.deepEqual(config.corsOrigins, ['http://localhost:5173']);
  });

  it('requires DATABASE_URL when persistence is postgres, and says how to avoid it', () => {
    assert.throws(() => loadConfig({ PERSISTENCE: 'postgres' }), /DATABASE_URL is required.*PERSISTENCE=memory/s);
  });

  it('accepts postgres with a connection string', () => {
    const config = loadConfig({ PERSISTENCE: 'postgres', DATABASE_URL: 'postgres://localhost/acc' });
    assert.equal(config.persistence, 'postgres');
    assert.equal(config.databaseUrl, 'postgres://localhost/acc');
  });

  it('rejects an unknown persistence mode rather than silently defaulting', () => {
    assert.throws(() => loadConfig({ PERSISTENCE: 'mongodb' }), /must be "postgres" or "memory"/);
  });

  it('parses booleans strictly', () => {
    assert.equal(loadConfig({ ...base, CONTINUE_ON_WORKER_FAILURE: 'false' }).continueOnWorkerFailure, false);
    assert.equal(loadConfig({ ...base, CONTINUE_ON_WORKER_FAILURE: '0' }).continueOnWorkerFailure, false);
    assert.throws(() => loadConfig({ ...base, CONTINUE_ON_WORKER_FAILURE: 'maybe' }), /must be true or false/);
  });

  it('rejects a non-integer port', () => {
    assert.throws(() => loadConfig({ ...base, PORT: 'eighty' }), /non-negative integer/);
    assert.throws(() => loadConfig({ ...base, PORT: '-1' }), /non-negative integer/);
  });

  it('rejects an inverted mock latency range', () => {
    assert.throws(
      () => loadConfig({ ...base, MOCK_MIN_LATENCY_MS: '900', MOCK_MAX_LATENCY_MS: '100' }),
      /greater than or equal/,
    );
  });

  it('splits a multi-origin CORS list and drops blanks', () => {
    const config = loadConfig({ ...base, CORS_ORIGIN: 'http://a.test, http://b.test ,' });
    assert.deepEqual(config.corsOrigins, ['http://a.test', 'http://b.test']);
  });

  it('treats blank values as unset', () => {
    assert.equal(loadConfig({ ...base, AI_PROVIDER: '   ' }).providerId, undefined);
  });

  it('defaults new missions to MADRE with no budget, no prices and Ollama not connected', () => {
    const config = loadConfig(base);
    assert.equal(config.defaultMissionMode, 'madre');
    assert.equal(config.ollamaBaseUrl, undefined);
    assert.equal(config.madre.budget.perMissionUsd, null);
    // Only the free-tier hosts are pre-priced (0 USD); nothing else is assumed.
    assert.deepEqual(Object.keys(config.madre.prices).sort(), ['cerebras', 'cloudflare', 'mistral', 'nvidia']);
  });

  it('reads MADRE settings and validates them', () => {
    const config = loadConfig({ ...base, DEFAULT_MISSION_MODE: 'classic', OLLAMA_BASE_URL: 'http://localhost:11434', MADRE_BUDGET_DAILY_USD: '2.5', MADRE_BUDGET_ON_EXCEED: 'fallback_local', MADRE_PRICES_JSON: '{"openai:x":{"inputPer1kUsd":0.1,"outputPer1kUsd":0.2}}' });
    assert.equal(config.defaultMissionMode, 'classic');
    assert.equal(config.madre.budget.dailyUsd, 2.5);
    assert.equal(config.madre.budget.onExceed, 'fallback_local');
    assert.equal(config.madre.prices['openai:x']?.outputPer1kUsd, 0.2);
    assert.throws(() => loadConfig({ ...base, DEFAULT_MISSION_MODE: 'turbo' }), /classic.*madre/);
    assert.throws(() => loadConfig({ ...base, MADRE_BUDGET_DAILY_USD: '-1' }), /non-negative number/);
    assert.throws(() => loadConfig({ ...base, MADRE_PRICES_JSON: '{bad' }), /valid JSON/);
    assert.throws(() => loadConfig({ ...base, MADRE_PRICES_JSON: '{"a":{"inputPer1kUsd":"x"}}' }), /needs non-negative numeric/);
  });
});

describe('loadConfig: real providers', () => {
  it('configures no real provider by default — nothing is guessed', () => {
    const c = loadConfig(base);
    assert.equal(c.realProviders.openai.apiKey, undefined);
    assert.equal(c.realProviders.anthropic.apiKey, undefined);
    assert.equal(c.realProviders.gemini.apiKey, undefined);
    assert.deepEqual(c.realProviders.openai.models, []);
    assert.deepEqual(c.disabledProviders, []);
  });

  it('reads keys, models and base URLs from the documented variables', () => {
    const c = loadConfig({
      ...base,
      OPENAI_API_KEY: 'k1', OPENAI_MODEL: 'm1, m2', OPENAI_API_BASE_URL: 'http://openai.test/v1',
      ANTHROPIC_API_KEY: 'k2', ANTHROPIC_MODEL: 'm3', ANTHROPIC_MAX_TOKENS: '2048',
      GOOGLE_API_KEY: 'k3', GEMINI_MODEL: 'm4',
    });
    assert.equal(c.realProviders.openai.apiKey, 'k1');
    assert.deepEqual(c.realProviders.openai.models, ['m1', 'm2']);
    assert.equal(c.realProviders.openai.baseUrl, 'http://openai.test/v1');
    assert.equal(c.realProviders.anthropic.apiKey, 'k2');
    assert.equal(c.realProviders.anthropic.maxOutputTokens, 2048);
    assert.equal(c.realProviders.gemini.apiKey, 'k3');
    assert.deepEqual(c.realProviders.gemini.models, ['m4']);
  });

  it('GOOGLE_API_KEY wins over the GEMINI_API_KEY alias; the alias works alone', () => {
    assert.equal(loadConfig({ ...base, GOOGLE_API_KEY: 'g', GEMINI_API_KEY: 'x' }).realProviders.gemini.apiKey, 'g');
    assert.equal(loadConfig({ ...base, GEMINI_API_KEY: 'x' }).realProviders.gemini.apiKey, 'x');
  });

  it('never reads ANTHROPIC_BASE_URL: that is sandbox routing, not a MADRE setting', () => {
    assert.equal(loadConfig({ ...base, ANTHROPIC_BASE_URL: 'http://proxy.internal' }).realProviders.anthropic.baseUrl, undefined);
  });

  it('blank values count as unset', () => {
    assert.equal(loadConfig({ ...base, OPENAI_API_KEY: '   ' }).realProviders.openai.apiKey, undefined);
  });

  it('parses MADRE_DISABLED_PROVIDERS as a list', () => {
    assert.deepEqual(loadConfig({ ...base, MADRE_DISABLED_PROVIDERS: 'openai, gemini ,' }).disabledProviders, ['openai', 'gemini']);
  });

  it('rejects a bad ANTHROPIC_MAX_TOKENS instead of ignoring it', () => {
    assert.throws(() => loadConfig({ ...base, ANTHROPIC_MAX_TOKENS: 'lots' }));
  });
});
