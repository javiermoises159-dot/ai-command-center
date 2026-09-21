import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { tavilySearch, WebToolError, wikipedia, type WebFetch } from './web.ts';

function reply(status: number, body: unknown): WebFetch {
  return async () => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
}

describe('wikipedia', () => {
  it('returns the intro, url and language of the best match', async () => {
    let seen = '';
    const fetch: WebFetch = async (url) => {
      seen = url;
      return { ok: true, status: 200, json: async () => ({ query: { pages: [{ title: 'Galleta', extract: 'Una galleta es…', fullurl: 'https://es.wikipedia.org/wiki/Galleta' }] } }), text: async () => '' };
    };
    const out = await wikipedia(fetch, 'galletas', 'es');
    assert.match(seen, /^https:\/\/es\.wikipedia\.org\/w\/api\.php\?/);
    assert.equal(out.title, 'Galleta');
    assert.equal(out.url, 'https://es.wikipedia.org/wiki/Galleta');
  });

  it('refuses a language that could redirect the request to another host', async () => {
    let seen = '';
    const fetch: WebFetch = async (url) => {
      seen = url;
      return { ok: true, status: 200, json: async () => ({ query: { pages: [{ title: 'x', extract: 'y' }] } }), text: async () => '' };
    };
    await wikipedia(fetch, 'x', 'evil.com/#');
    assert.match(seen, /^https:\/\/es\.wikipedia\.org\//);
  });

  it('retries with keywords when a whole sentence finds nothing', async () => {
    const queries: string[] = [];
    const fetch: WebFetch = async (url) => {
      const q = new URL(url).searchParams.get('gsrsearch') ?? '';
      queries.push(q);
      const body = queries.length === 1 ? { batchcomplete: true } : { query: { pages: [{ title: 'Turín', extract: 'Turín es una ciudad.', fullurl: 'https://es.wikipedia.org/wiki/Tur%C3%ADn' }] } };
      return { ok: true, status: 200, json: async () => body, text: async () => '' };
    };
    const out = await wikipedia(fetch, 'Montar una agencia digital en Turín para optimizar fichas', 'es');
    assert.equal(queries.length, 2);
    assert.ok(queries[1]!.length < queries[0]!.length && /Turín/.test(queries[1]!));
    assert.equal(out.title, 'Turín');
  });

  it('fails plainly when nothing matches', async () => {
    await assert.rejects(wikipedia(reply(200, { batchcomplete: true }), 'zzzz', 'es'), WebToolError);
  });
});

describe('tavilySearch', () => {
  it('normalises results, drops non-http urls and never leaks the key', async () => {
    const out = await tavilySearch(
      reply(200, { results: [{ title: 'A', url: 'https://a.example', content: 'texto', published_date: '2026-01-01' }, { title: 'B', url: 'javascript:alert(1)', content: '' }] }),
      'tvly-secret',
      'cookies italia',
      5,
    );
    assert.equal(out.results.length, 1);
    assert.equal(out.results[0]?.url, 'https://a.example');
    assert.ok(!JSON.stringify(out).includes('tvly-secret'));
  });

  it('explains a rejected key and an exhausted quota without echoing the key', async () => {
    await assert.rejects(tavilySearch(reply(401, {}), 'tvly-secret', 'q', 3), (e: Error) => /clave/.test(e.message) && !e.message.includes('tvly-secret'));
    await assert.rejects(tavilySearch(reply(429, {}), 'tvly-secret', 'q', 3), /cupo/);
  });
});
