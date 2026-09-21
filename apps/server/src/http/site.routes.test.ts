import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { silentLogger } from '@acc/domain';
import type { MissionService } from '@acc/orchestrator';
import { ProviderRegistry } from '@acc/providers';

import { PublishError, type SitePublisher } from '../publish/github-pages.ts';
import { createRouter } from './router.ts';

const HTML = '<!doctype html>\n<html lang="it"><head><meta charset="utf-8"><title>Biscotti Rossi</title></head><body><p>ciao</p><script>const WHATSAPP_NUMBER = "";</script></body></html>';

function setup(finalResults: (string | null)[], publisher?: SitePublisher) {
  return build(finalResults, publisher);
}

function build(finalResults: (string | null)[], publisher?: SitePublisher) {
  const missions = {
    get: async () => ({
      mission: { title: 'Web de galletas' },
      runs: finalResults.map((finalResult, i) => ({ run: { attempt: i + 1, finalResult }, agents: [] })),
    }),
  } as unknown as MissionService;
  const router = createRouter({ missions, providers: new ProviderRegistry(), logger: silentLogger, version: 't', sitePublisher: publisher });
  return (method: 'GET' | 'POST', path: string, body?: unknown) => router.handle({ method, path, query: {}, body, headers: {} });
}

const okPublisher = (seen: { slug?: string; html?: string } = {}): SitePublisher => ({
  repo: 'o/r',
  publish: async (input) => {
    seen.slug = input.slug;
    seen.html = input.html;
    return { url: `https://o.github.io/r/${input.slug}/`, path: `${input.slug}/index.html`, commitUrl: null, note: null };
  },
});

describe('site publishing endpoints', () => {
  it('reports whether publishing is configured, without any secret', async () => {
    assert.deepEqual((await setup([], undefined)('GET', '/api/site/status')).body, { publishing: { configured: false, repo: null } });
    assert.deepEqual((await setup([], okPublisher())('GET', '/api/site/status')).body, { publishing: { configured: true, repo: 'o/r' } });
  });

  it('publishes the page of the newest run that has one', async () => {
    const seen: { slug?: string; html?: string } = {};
    const res = await setup([`\`\`\`html\n${HTML.replace('Rossi', 'Viejo')}\n\`\`\``, `# Informe\n\n\`\`\`html\n${HTML}\n\`\`\``, 'sin página'], okPublisher(seen))('POST', '/api/missions/abc123def/site/publish');
    assert.equal(res.status, 200);
    assert.equal(seen.html, HTML, 'without a number the page is published as delivered');
    assert.match(seen.slug ?? '', /^biscotti-rossi-abc123$/);
    assert.equal((res.body as any).site.url, `https://o.github.io/r/${seen.slug}/`);
  });

  it('writes a valid WhatsApp number into the page and ignores junk', async () => {
    const seen: { slug?: string; html?: string } = {};
    const run = setup([`\`\`\`html\n${HTML}\n\`\`\``], okPublisher(seen));
    await run('POST', '/api/missions/x/site/publish', { whatsapp: '+39 333 123 4567' });
    assert.match(seen.html ?? '', /WHATSAPP_NUMBER = "393331234567"/);
    await run('POST', '/api/missions/x/site/publish', { whatsapp: '"><script>alert(1)</script>' });
    assert.equal(seen.html, HTML);
  });

  it('answers 404 when the mission has no page and 409 when publishing is off', async () => {
    assert.equal((await setup(['# Informe'], okPublisher())('POST', '/api/missions/x/site/publish')).status, 404);
    assert.equal((await setup([`\`\`\`html\n${HTML}\n\`\`\``])('POST', '/api/missions/x/site/publish')).status, 409);
  });

  it('shows the publisher\'s own explanation when GitHub refuses', async () => {
    const failing: SitePublisher = { repo: 'o/r', publish: async () => { throw new PublishError('El repositorio o/r es privado.', 409); } };
    const res = await setup([`\`\`\`html\n${HTML}\n\`\`\``], failing)('POST', '/api/missions/x/site/publish');
    assert.equal(res.status, 409);
    assert.match(JSON.stringify(res.body), /privado/);
  });
});
