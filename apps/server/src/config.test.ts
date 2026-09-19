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
});
