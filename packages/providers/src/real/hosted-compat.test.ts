import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createCerebras, createCloudflare, createMistral } from './hosted-compat.ts';
import type { HttpFetch } from './http.ts';

const ok = (seen: { url?: string; auth?: string }): HttpFetch =>
  (async (url: string, init?: { headers?: Record<string, string> }) => {
    seen.url = url;
    seen.auth = init?.headers?.authorization;
    return new Response(JSON.stringify({ id: 'r1', choices: [{ message: { content: 'hola' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as HttpFetch;

const task = (model: string) => ({ model, systemPrompt: 's', prompt: 'p' }) as never;

describe('hosted free-tier providers', () => {
  it('Cerebras and Mistral use their own built-in host and id', async () => {
    const seen: { url?: string; auth?: string } = {};
    const c = createCerebras({ apiKey: 'k1', models: ['m1'], fetch: ok(seen) });
    assert.equal(c.id, 'cerebras');
    assert.equal(c.availability, 'available');
    const res = await c.execute(task('m1'));
    assert.equal(res.provider, 'cerebras');
    assert.equal(seen.url, 'https://api.cerebras.ai/v1/chat/completions');
    assert.equal(seen.auth, 'Bearer k1');
    const m = createMistral({ apiKey: 'k2', models: ['m2'], fetch: ok(seen) });
    await m.execute(task('m2'));
    assert.equal(m.id, 'mistral');
    assert.equal(seen.url, 'https://api.mistral.ai/v1/chat/completions');
  });

  it('is unconfigured, and says which variable is missing, without a key or model', () => {
    const c = createCerebras({});
    assert.equal(c.availability, 'unconfigured');
    assert.match(c.configuration().reason ?? '', /CEREBRAS_API_KEY/);
    assert.deepEqual(c.listModels(), []);
  });

  it('Cloudflare builds its URL from the account id and needs it', async () => {
    const seen: { url?: string } = {};
    const cf = createCloudflare({ apiKey: 't', models: ['@cf/x/y'], accountId: 'abc123', fetch: ok(seen) });
    assert.equal(cf.availability, 'available');
    await cf.execute(task('@cf/x/y'));
    assert.equal(seen.url, 'https://api.cloudflare.com/client/v4/accounts/abc123/ai/v1/chat/completions');
    const missing = createCloudflare({ apiKey: 't', models: ['@cf/x/y'] });
    assert.equal(missing.availability, 'unconfigured');
    assert.match(missing.configuration().reason ?? '', /CLOUDFLARE_ACCOUNT_ID/);
  });

  it('never leaks the key in an error', async () => {
    const bad = (async () => new Response('{"error":"nope"}', { status: 401 })) as unknown as HttpFetch;
    const c = createMistral({ apiKey: 'sk-secret-123', models: ['m'], fetch: bad });
    await assert.rejects(c.execute(task('m')), (e: Error) => !JSON.stringify(e).includes('sk-secret-123') && !e.message.includes('sk-secret-123'));
  });
});

import { createNvidia } from './hosted-compat.ts';

describe('NVIDIA NIM', () => {
  it('uses its own host and id', async () => {
    const seen: { url?: string; auth?: string } = {};
    const n = createNvidia({ apiKey: 'nk', models: ['meta/llama-3.3-70b-instruct'], fetch: ok(seen) });
    assert.equal(n.id, 'nvidia');
    await n.execute(task('meta/llama-3.3-70b-instruct'));
    assert.equal(seen.url, 'https://integrate.api.nvidia.com/v1/chat/completions');
    assert.match(createNvidia({}).configuration().reason ?? '', /NVIDIA_API_KEY/);
  });
});
