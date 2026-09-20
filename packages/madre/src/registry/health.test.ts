import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { checkAllProviders, checkProviderHealth, type FetchLike } from './health.ts';
import type { ProviderProfile } from '../types.ts';

const AT = new Date('2026-01-01T00:00:00.000Z');
const now = () => AT;

type Probe = Pick<ProviderProfile, 'id' | 'executable' | 'tier'>;

const provider = (over: Partial<Probe> = {}): Probe => ({
  id: 'ollama',
  executable: true,
  tier: 'local',
  ...over,
});

const respond = (status: number): FetchLike => async () => ({ ok: status < 400, status });

describe('checkProviderHealth', () => {
  it('reports the simulation as available without touching the network', async () => {
    let called = false;
    const health = await checkProviderHealth(provider({ id: 'mock', tier: 'mock' }), {
      now,
      fetch: async () => {
        called = true;
        return { ok: true, status: 200 };
      },
    });
    assert.equal(health.status, 'ok');
    assert.equal(called, false, 'the simulation has no endpoint to probe');
    assert.match(health.detail, /[Ss]imulaci/);
  });

  it('separates "nothing to check" from "down"', async () => {
    const stub = await checkProviderHealth(provider({ id: 'openai', executable: false, tier: 'external' }), { now });
    assert.equal(stub.status, 'not_connected');
    assert.equal(stub.checkedAt, AT.toISOString());
    assert.equal(stub.latencyMs, null);

    const noUrl = await checkProviderHealth(provider(), { now, ollamaBaseUrl: undefined });
    assert.equal(noUrl.status, 'not_connected');
    assert.match(noUrl.detail, /OLLAMA_BASE_URL/);
  });

  it('never reports ok just because the configuration looks complete', async () => {
    const health = await checkProviderHealth(provider({ id: 'anthropic', executable: true, tier: 'external' }), { now });
    assert.equal(health.status, 'unknown', 'an executable provider with no probe is unknown, not ok');
  });

  it('reports ok when the local server answers', async () => {
    let seen = '';
    const fetchImpl: FetchLike = async (url) => {
      seen = url;
      return { ok: true, status: 200 };
    };
    const health = await checkProviderHealth(provider(), { now, fetch: fetchImpl, ollamaBaseUrl: 'http://x/' });
    assert.equal(health.status, 'ok');
    assert.equal(seen, 'http://x/api/tags');
    assert.ok(health.latencyMs !== null && health.latencyMs >= 0);
  });

  it('reports down on an HTTP error, with the status in the detail', async () => {
    const health = await checkProviderHealth(provider(), { now, fetch: respond(500), ollamaBaseUrl: 'http://x' });
    assert.equal(health.status, 'down');
    assert.match(health.detail, /HTTP 500/);
  });

  it('never throws when the transport throws', async () => {
    const health = await checkProviderHealth(provider(), {
      now,
      ollamaBaseUrl: 'http://x',
      fetch: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    assert.equal(health.status, 'down');
    assert.match(health.detail, /ECONNREFUSED/);
  });

  it('times out instead of hanging', async () => {
    const hang: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
    const health = await checkProviderHealth(provider(), {
      now,
      fetch: hang,
      ollamaBaseUrl: 'http://x',
      timeoutMs: 20,
    });
    assert.equal(health.status, 'down');
    assert.match(health.detail, /no respondió en 20 ms/);
  });
});

describe('checkAllProviders', () => {
  it('checks every provider and lets none fail the batch', async () => {
    const health = await checkAllProviders(
      [
        provider({ id: 'mock', tier: 'mock' }),
        provider({ id: 'ollama' }),
        provider({ id: 'openai', executable: false, tier: 'external' }),
      ],
      {
        now,
        ollamaBaseUrl: 'http://x',
        fetch: async () => {
          throw new Error('down');
        },
      },
    );

    assert.equal(health.get('mock')?.status, 'ok');
    assert.equal(health.get('ollama')?.status, 'down');
    assert.equal(health.get('openai')?.status, 'not_connected');
  });
});
