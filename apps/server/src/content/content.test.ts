import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { silentLogger } from '@acc/domain';
import type { MissionService } from '@acc/orchestrator';
import { ProviderRegistry } from '@acc/providers';

import { createRouter } from '../http/router.ts';
import { CloudflareMedia, MediaError, type Fetch, type MediaGenerator } from './media.ts';
import { MemoryContentStore } from './store.ts';

const fakeMedia: MediaGenerator = {
  image: async (prompt) => ({ mime: 'image/jpeg', base64: Buffer.from(`img:${prompt}`).toString('base64') }),
  voice: async (text, lang) => ({ mime: 'audio/mpeg', base64: Buffer.from(`voice:${lang}:${text}`).toString('base64') }),
};

function api(media: MediaGenerator | null = fakeMedia) {
  const router = createRouter({
    missions: {} as MissionService,
    providers: new ProviderRegistry(),
    logger: silentLogger,
    version: 't',
    content: { store: new MemoryContentStore(), media: media ?? undefined },
  });
  return async (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown) => {
    const res = await router.handle({ method, path, query: {}, body, headers: {} });
    return { status: res.status, body: res.body as any };
  };
}

describe('content calendar', () => {
  it('creates a draft, schedules it by giving a date, and lists soonest first', async () => {
    const call = api();
    const later = await call('POST', '/api/content', { title: 'Reel de galletas', scheduledAt: '2026-10-02T09:00:00Z' });
    assert.equal(later.status, 201);
    assert.equal(later.body.item.status, 'scheduled');
    const draft = await call('POST', '/api/content', { title: 'Idea suelta' });
    assert.equal(draft.body.item.status, 'draft');
    const sooner = await call('POST', '/api/content', { title: 'Post', scheduledAt: '2026-10-01T09:00:00Z', platform: 'facebook' });
    const list = await call('GET', '/api/content');
    assert.deepEqual(list.body.items.map((i: any) => i.title), ['Post', 'Reel de galletas', 'Idea suelta']);
    assert.equal(sooner.body.item.platform, 'facebook');
  });

  it('marks as published (stamping the time) and back to draft when the date is cleared', async () => {
    const call = api();
    const { item } = (await call('POST', '/api/content', { title: 'X', scheduledAt: '2026-10-01T09:00:00Z' })).body;
    const done = (await call('PATCH', `/api/content/${item.id}`, { status: 'published' })).body.item;
    assert.equal(done.status, 'published');
    assert.ok(done.publishedAt);
    const cleared = (await call('PATCH', `/api/content/${item.id}`, { status: 'draft', scheduledAt: null })).body.item;
    assert.equal(cleared.status, 'draft');
    assert.equal(cleared.publishedAt, null);
  });

  it('rejects bad input with a 400 and a message in Spanish', async () => {
    const call = api();
    assert.equal((await call('POST', '/api/content', {})).status, 400);
    assert.equal((await call('POST', '/api/content', { title: 'a', platform: 'myspace' })).status, 400);
    assert.equal((await call('POST', '/api/content', { title: 'a', scheduledAt: 'mañana' })).status, 400);
    assert.equal((await call('POST', '/api/content', { title: 'a'.repeat(500) })).status, 400);
  });

  it('answers 404 for an unknown item and deletes existing ones', async () => {
    const call = api();
    assert.equal((await call('PATCH', '/api/content/nope', { title: 'x' })).status, 404);
    assert.equal((await call('DELETE', '/api/content/nope')).status, 404);
    const { item } = (await call('POST', '/api/content', { title: 'X' })).body;
    assert.equal((await call('DELETE', `/api/content/${item.id}`)).status, 200);
    assert.equal((await call('GET', '/api/content')).body.items.length, 0);
  });

  it('generates a picture and a voice-over, keeps them out of listings, and serves them on request', async () => {
    const call = api();
    const { item } = (await call('POST', '/api/content', { title: 'X', imagePrompt: 'galletas de chocolate' })).body;
    const withImage = (await call('POST', `/api/content/${item.id}/image`, {})).body.item;
    assert.equal(withImage.hasImage, true);
    const withVoice = (await call('POST', `/api/content/${item.id}/voice`, { text: 'Hola', lang: 'es' })).body.item;
    assert.equal(withVoice.hasAudio, true);
    assert.equal(withVoice.voiceText, 'Hola');
    const listed = (await call('GET', '/api/content')).body.items[0];
    assert.equal('imageB64' in listed, false);
    const image = (await call('GET', `/api/content/${item.id}/media/image`)).body;
    assert.equal(Buffer.from(image.base64, 'base64').toString(), 'img:galletas de chocolate');
    assert.equal((await call('GET', `/api/content/${item.id}/media/video`)).status, 400);
  });

  it('needs a description before generating, and says so when Cloudflare is not configured', async () => {
    const call = api();
    const { item } = (await call('POST', '/api/content', { title: 'X' })).body;
    assert.equal((await call('POST', `/api/content/${item.id}/image`, {})).status, 400);
    assert.equal((await call('POST', `/api/content/${item.id}/voice`, { lang: 'it' })).status, 400);
    const off = api(null);
    const made = (await off('POST', '/api/content', { title: 'X', imagePrompt: 'a' })).body.item;
    const res = await off('POST', `/api/content/${made.id}/image`, {});
    assert.equal(res.status, 409);
    assert.match(JSON.stringify(res.body), /CLOUDFLARE_API_TOKEN/);
    assert.equal((await off('GET', '/api/content/status')).body.media.configured, false);
  });

  it('shows the media provider\'s own message when it fails', async () => {
    const failing: MediaGenerator = { image: async () => { throw new MediaError('Se agotó el cupo gratuito de Cloudflare por hoy.', 429); }, voice: fakeMedia.voice };
    const call = api(failing);
    const { item } = (await call('POST', '/api/content', { title: 'X', imagePrompt: 'a' })).body;
    const res = await call('POST', `/api/content/${item.id}/image`, {});
    assert.equal(res.status, 429);
    assert.match(JSON.stringify(res.body), /cupo gratuito/);
  });
});

describe('CloudflareMedia', () => {
  const reply = (status: number, body: unknown): Fetch => async () => ({ ok: status < 300, status, text: async () => JSON.stringify(body) });

  it('reads the image and voice out of Cloudflare\'s envelope, and never sends the key anywhere but the header', async () => {
    let seen: { url: string; headers: Record<string, string>; body: string } | undefined;
    const spy: Fetch = async (url, init) => {
      seen = { url, headers: init.headers, body: init.body };
      return { ok: true, status: 200, text: async () => JSON.stringify({ result: { image: '/9j/AAAA', audio: 'SUQz' }, success: true }) };
    };
    const media = new CloudflareMedia('acct', 'secret-token', spy);
    assert.deepEqual(await media.image('un logo'), { mime: 'image/jpeg', base64: '/9j/AAAA' });
    assert.match(seen?.url ?? '', /accounts\/acct\/ai\/run\/@cf\/black-forest-labs\/flux-1-schnell$/);
    assert.equal(seen?.headers.authorization, 'Bearer secret-token');
    assert.equal(seen?.body.includes('secret-token'), false);
    assert.deepEqual(await media.voice('hola', 'es'), { mime: 'audio/mpeg', base64: 'SUQz' });
  });

  it('turns auth, quota and unknown failures into actionable messages', async () => {
    await assert.rejects(new CloudflareMedia('a', 't', reply(403, { errors: [] })).image('x'), /CLOUDFLARE_API_TOKEN/);
    await assert.rejects(new CloudflareMedia('a', 't', reply(429, {})).image('x'), /cupo gratuito/);
    await assert.rejects(new CloudflareMedia('a', 't', reply(400, { errors: [{ message: 'bad prompt' }] })).image('x'), /bad prompt/);
    await assert.rejects(new CloudflareMedia('a', 't', reply(200, { result: {} })).image('x'), /ninguna imagen/);
  });
});
