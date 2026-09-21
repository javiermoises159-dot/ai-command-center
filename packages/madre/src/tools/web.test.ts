import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { gdeltNews, tavilySearch, WebToolError, wikipedia, type WebFetch } from './web.ts';

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

describe('gdeltNews', () => {
  const text = (status: number, body: string): WebFetch => async () => ({ ok: status < 300, status, json: async () => JSON.parse(body), text: async () => body });

  it('returns titles, links and ISO dates, skipping duplicates and non-http links', async () => {
    let seen = '';
    const fetch: WebFetch = async (url) => {
      seen = url;
      return text(200, JSON.stringify({ articles: [
        { url: 'https://a.example/1', title: 'Uno', domain: 'a.example', language: 'Italian', seendate: '20260921T103000Z' },
        { url: 'https://a.example/1', title: 'Repetida' },
        { url: 'javascript:alert(1)', title: 'Mala' },
      ] }))(url);
    };
    const out = await gdeltNews(fetch, 'Quiero abrir una tienda de galletas en Torino', 5);
    assert.match(seen, /^https:\/\/api\.gdeltproject\.org\/api\/v2\/doc\/doc\?/);
    assert.match(seen, /mode=artlist/);
    assert.equal(out.articles.length, 1);
    assert.equal(out.articles[0]?.publishedAt, '2026-09-21T10:30:00Z');
  });

  it('turns GDELT plain-text errors and rate limits into a clear failure', async () => {
    await assert.rejects(gdeltNews(text(200, 'Timespan is too short.'), 'galletas artesanales', 5), /GDELT no devolvió noticias/);
    await assert.rejects(gdeltNews(text(429, 'slow down'), 'galletas artesanales', 5), /demasiadas peticiones/);
  });

  it('strips search operators from the query', async () => {
    let seen = '';
    await gdeltNews(async (url) => { seen = url; return text(200, '{"articles":[]}')(url); }, 'galletas OR "sourcelang:italian" (x)', 5);
    assert.ok(!decodeURIComponent(seen).includes('"'));
  });
});
