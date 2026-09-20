import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ProviderFailedError, ProviderNotConfiguredError, type ProviderTask } from '@acc/domain';

import { createProviderRegistry } from '../index.ts';
import { discoverOllamaModels, OllamaProvider, type FetchLike } from './ollama.ts';

const task: ProviderTask = { agentId: 'strategy', systemPrompt: 'sys', prompt: 'hello', model: 'llama3.1:8b', temperature: 0.2, maxTokens: 100 };
const models = [{ id: 'llama3.1:8b', label: 'llama3.1:8b (local)' }];
const reply = (status: number, body: unknown): FetchLike => async () => ({ ok: status >= 200 && status < 300, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });

describe('OllamaProvider', () => {
  it('is planned (NOT CONNECTED) without a base URL and refuses to execute', async () => {
    const p = new OllamaProvider({});
    assert.equal(p.availability, 'planned');
    assert.match(p.unavailableReason() ?? '', /OLLAMA_BASE_URL/);
    await assert.rejects(() => p.execute(task), ProviderNotConfiguredError);
  });

  it('is planned when the server has no models', () => {
    assert.equal(new OllamaProvider({ baseUrl: 'http://x', models: [] }).availability, 'planned');
  });

  it('normalises a chat response', async () => {
    let seen: { url: string; body: any } | null = null;
    const fetch: FetchLike = async (url, init) => {
      seen = { url, body: JSON.parse(init?.body ?? '{}') };
      return { ok: true, status: 200, text: async () => JSON.stringify({ message: { role: 'assistant', content: 'Hi' }, prompt_eval_count: 11, eval_count: 5, done_reason: 'stop' }) };
    };
    const p = new OllamaProvider({ baseUrl: 'http://localhost:11434/', models, fetch });
    assert.equal(p.availability, 'available');
    const r = await p.execute(task);
    assert.equal(r.provider, 'ollama');
    assert.equal(r.text, 'Hi');
    assert.deepEqual(r.usage, { promptTokens: 11, completionTokens: 5, totalTokens: 16 });
    assert.equal(r.finishReason, 'stop');
    assert.equal(seen!.url, 'http://localhost:11434/api/chat');
    assert.equal(seen!.body.stream, false);
    assert.equal(seen!.body.options.num_predict, 100);
    assert.equal(seen!.body.messages[0].role, 'system');
  });

  it('maps failures to ProviderFailedError', async () => {
    const mk = (fetch: FetchLike) => new OllamaProvider({ baseUrl: 'http://x', models, fetch });
    await assert.rejects(() => mk(reply(500, 'boom')).execute(task), /HTTP 500/);
    await assert.rejects(() => mk(reply(200, 'not json')).execute(task), /no es JSON/);
    await assert.rejects(() => mk(reply(200, { nope: 1 })).execute(task), /no contenía ningún mensaje/);
    await assert.rejects(() => mk(async () => { throw new Error('ECONNREFUSED'); }).execute(task), (e: unknown) => e instanceof ProviderFailedError && /No se pudo conectar/.test(e.message));
  });

  it('honours cancellation and timeouts', async () => {
    const hang: FetchLike = (_u, init) => new Promise((_res, rej) => init?.signal?.addEventListener('abort', () => rej(new Error('aborted'))));
    const c = new AbortController();
    const p = new OllamaProvider({ baseUrl: 'http://x', models, fetch: hang });
    const pending = p.execute(task, c.signal);
    c.abort();
    await assert.rejects(() => pending, /cancelada/);
    await assert.rejects(() => new OllamaProvider({ baseUrl: 'http://x', models, fetch: hang, timeoutMs: 20 }).execute(task), /Se agotó el tiempo/);
  });
});

describe('discoverOllamaModels', () => {
  it('lists installed models', async () => {
    const r = await discoverOllamaModels('http://x/', reply(200, { models: [{ name: 'a:7b' }, { name: 'b:70b' }, {}] }));
    assert.deepEqual(r.models.map((m) => m.id), ['a:7b', 'b:70b']);
    assert.equal(r.error, null);
  });
  it('never throws and explains why it found nothing', async () => {
    assert.match((await discoverOllamaModels(undefined)).error ?? '', /no está definida/);
    assert.match((await discoverOllamaModels('http://x', reply(500, ''))).error ?? '', /HTTP 500/);
    assert.match((await discoverOllamaModels('http://x', async () => { throw new Error('down'); })).error ?? '', /No se pudo conectar/);
    assert.match((await discoverOllamaModels('http://x', reply(200, { models: [] }))).error ?? '', /no tiene modelos/);
  });
});

describe('registry with ollama', () => {
  it('lists ollama as not connected by default and connected when configured', () => {
    const off = createProviderRegistry().describe().find((d) => d.id === 'ollama');
    assert.equal(off?.availability, 'planned');
    assert.match(off?.note ?? '', /NO CONECTADO/);
    const on = createProviderRegistry({ ollama: { baseUrl: 'http://x', models } }).describe().find((d) => d.id === 'ollama');
    assert.equal(on?.availability, 'available');
    assert.equal(createProviderRegistry({ ollama: { baseUrl: 'http://x', models } }).defaultProviderId(), 'mock');
  });
});
