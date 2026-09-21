import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { GitHubPagesPublisher, PublishError, parseRepo, type GitHubFetch } from './github-pages.ts';

const HTML = '<!doctype html>\n<html lang="es"><head><meta charset="utf-8"><title>Rossi</title></head><body><p>hola</p></body></html>';
const TOKEN = 'github_pat_SECRET123';

interface Call { method: string; url: string; body: Record<string, unknown> | null; auth: string }

/** A fake GitHub: `script` answers by "METHOD path" (query string ignored). */
function fake(script: Record<string, { status: number; json?: unknown }>): { fetch: GitHubFetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: GitHubFetch = async (url, init) => {
    const path = url.replace('https://api.github.com', '').split('?')[0]!;
    calls.push({ method: init.method, url: path, body: init.body === undefined ? null : JSON.parse(init.body), auth: init.headers['authorization'] ?? '' });
    const answer = script[`${init.method} ${path}`] ?? { status: 404, json: { message: 'Not Found' } };
    return { ok: answer.status < 300, status: answer.status, json: async () => answer.json ?? {} };
  };
  return { fetch, calls };
}

const REPO = { status: 200, json: { private: false, default_branch: 'main' } };

describe('parseRepo', () => {
  it('accepts owner/repository and nothing else', () => {
    assert.deepEqual(parseRepo('javier/acc-sites'), { owner: 'javier', name: 'acc-sites' });
    assert.equal(parseRepo('acc-sites'), null);
    assert.equal(parseRepo('a/b/c'), null);
    assert.equal(parseRepo('https://github.com/a/b'), null);
  });
});

describe('GitHubPagesPublisher', () => {
  it('creates the file in its own folder and returns the Pages address', async () => {
    const { fetch, calls } = fake({
      'GET /repos/javier/acc-sites': REPO,
      'PUT /repos/javier/acc-sites/contents/rossi-abc123/index.html': { status: 201, json: { commit: { html_url: 'https://github.com/javier/acc-sites/commit/1' } } },
      'GET /repos/javier/acc-sites/pages': { status: 200 },
    });
    const site = await new GitHubPagesPublisher(TOKEN, 'javier/acc-sites', fetch).publish({ slug: 'rossi-abc123', html: HTML });
    assert.equal(site.url, 'https://javier.github.io/acc-sites/rossi-abc123/');
    assert.equal(site.note, null);
    const put = calls.find((c) => c.method === 'PUT')!;
    assert.equal(Buffer.from(String(put.body?.['content']), 'base64').toString('utf8'), HTML);
    assert.equal(put.body?.['branch'], 'main');
    assert.equal(put.body?.['sha'], undefined);
    assert.ok(calls.every((c) => c.auth === `Bearer ${TOKEN}`));
  });

  it('updates an existing folder with its sha instead of failing', async () => {
    const { fetch, calls } = fake({
      'GET /repos/javier/acc-sites': REPO,
      'GET /repos/javier/acc-sites/contents/rossi-abc123/index.html': { status: 200, json: { sha: 'old-sha' } },
      'PUT /repos/javier/acc-sites/contents/rossi-abc123/index.html': { status: 200, json: {} },
      'GET /repos/javier/acc-sites/pages': { status: 200 },
    });
    await new GitHubPagesPublisher(TOKEN, 'javier/acc-sites', fetch).publish({ slug: 'rossi-abc123', html: HTML });
    assert.equal(calls.find((c) => c.method === 'PUT')!.body?.['sha'], 'old-sha');
  });

  it('turns Pages on when it is off, and says what to do when that is not allowed', async () => {
    const base = { 'GET /repos/o/r': REPO, 'PUT /repos/o/r/contents/s-1/index.html': { status: 201, json: {} } };
    const on = fake({ ...base, 'GET /repos/o/r/pages': { status: 404 }, 'POST /repos/o/r/pages': { status: 201 } });
    assert.equal((await new GitHubPagesPublisher(TOKEN, 'o/r', on.fetch).publish({ slug: 's-1', html: HTML })).note, null);
    assert.ok(on.calls.some((c) => c.method === 'POST'));
    const denied = fake({ ...base, 'GET /repos/o/r/pages': { status: 404 }, 'POST /repos/o/r/pages': { status: 403 } });
    const site = await new GitHubPagesPublisher(TOKEN, 'o/r', denied.fetch).publish({ slug: 's-1', html: HTML });
    assert.match(site.note ?? '', /Settings → Pages/);
    assert.match(site.url, /^https:\/\/o\.github\.io\/r\/s-1\/$/);
  });

  it('uses the root address for a user site repository', async () => {
    const { fetch } = fake({ 'GET /repos/ana/ana.github.io': REPO, 'PUT /repos/ana/ana.github.io/contents/x-1/index.html': { status: 201, json: {} }, 'GET /repos/ana/ana.github.io/pages': { status: 200 } });
    const site = await new GitHubPagesPublisher(TOKEN, 'ana/ana.github.io', fetch).publish({ slug: 'x-1', html: HTML });
    assert.equal(site.url, 'https://ana.github.io/x-1/');
  });

  it('explains the common failures without leaking the token', async () => {
    const run = (script: Record<string, { status: number; json?: unknown }>) => new GitHubPagesPublisher(TOKEN, 'o/r', fake(script).fetch).publish({ slug: 's-1', html: HTML });
    await assert.rejects(run({ 'GET /repos/o/r': { status: 401 } }), /rechazó el token/);
    await assert.rejects(run({}), /No encuentro el repositorio/);
    await assert.rejects(run({ 'GET /repos/o/r': { status: 200, json: { private: true } } }), /privado/);
    await assert.rejects(run({ 'GET /repos/o/r': REPO, 'PUT /repos/o/r/contents/s-1/index.html': { status: 403, json: { message: TOKEN } } }), (e: Error) => /Contents/.test(e.message) && !e.message.includes(TOKEN));
    await assert.rejects(run({ 'GET /repos/o/r': REPO, 'PUT /repos/o/r/contents/s-1/index.html': { status: 500, json: { message: 'boom' } } }), (e: Error) => e instanceof PublishError && /500/.test(e.message));
  });

  it('refuses an unsafe folder name and a page that fails the safety check, before calling GitHub', async () => {
    const { fetch, calls } = fake({});
    const publisher = new GitHubPagesPublisher(TOKEN, 'o/r', fetch);
    await assert.rejects(publisher.publish({ slug: '../evil', html: HTML }), /no es válido/);
    await assert.rejects(publisher.publish({ slug: 'ok-1', html: HTML.replace('<p>', '<script src="https://x.example/a.js"></script><p>') }), /no se puede publicar/);
    assert.equal(calls.length, 0);
  });
});
