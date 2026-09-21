import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { silentLogger } from '@acc/domain';
import type { MissionService } from '@acc/orchestrator';
import { ProviderRegistry } from '@acc/providers';

import { createRouter } from '../http/router.ts';
import { buildMedia, CloudflareMedia, GeminiVoice, MediaError, pcmToWavBase64, TRANSLATE_MODEL, type Fetch, type MediaGenerator } from './media.ts';
import { MemoryContentStore } from './store.ts';

const fakeMedia: MediaGenerator = {
  image: async (prompt) => ({ mime: 'image/jpeg', base64: Buffer.from(`img:${prompt}`).toString('base64') }),
  voice: {
    langs: ['es', 'it', 'en'],
    speak: async (text, lang) => ({ mime: 'audio/wav', base64: Buffer.from(`voice:${lang}:${text}`).toString('base64') }),
  },
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
    assert.equal((await call('GET', `/api/content/${item.id}/media/video`)).status, 404, 'a valid kind with nothing stored yet');
    assert.equal((await call('GET', `/api/content/${item.id}/media/document`)).status, 400, 'the kind is a closed list');
  });

  it('needs a description before generating, and says so when Cloudflare is not configured', async () => {
    const call = api();
    const { item } = (await call('POST', '/api/content', { title: 'X' })).body;
    assert.equal((await call('POST', `/api/content/${item.id}/image`, {})).status, 400);
    assert.equal((await call('POST', `/api/content/${item.id}/voice`, { lang: 'it' })).status, 400);
    // A language the configured voice cannot speak is refused, not sent to the service.
    await call('PATCH', `/api/content/${item.id}`, { voiceText: 'Ciao' });
    assert.equal((await call('POST', `/api/content/${item.id}/voice`, { lang: 'fr' })).status, 400);
    const off = api(null);
    const made = (await off('POST', '/api/content', { title: 'X', imagePrompt: 'a' })).body.item;
    const res = await off('POST', `/api/content/${made.id}/image`, {});
    assert.equal(res.status, 409);
    assert.match(JSON.stringify(res.body), /CLOUDFLARE_API_TOKEN/);
    assert.deepEqual((await off('GET', '/api/content/status')).body.media, { image: false, voiceLangs: [], video: false, edit: false });
    assert.deepEqual((await api()('GET', '/api/content/status')).body.media, { image: true, voiceLangs: ['es', 'it', 'en'], video: false, edit: false });
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
    assert.deepEqual(await media.voice('hello', 'en'), { mime: 'audio/mpeg', base64: 'SUQz' });
    assert.match(seen?.body ?? '', /"lang":"en"/);
  });

  it('turns auth, quota and unknown failures into actionable messages', async () => {
    await assert.rejects(new CloudflareMedia('a', 't', reply(403, { errors: [] })).image('x'), /CLOUDFLARE_API_TOKEN/);
    await assert.rejects(new CloudflareMedia('a', 't', reply(429, {})).image('x'), /cupo gratuito/);
    await assert.rejects(new CloudflareMedia('a', 't', reply(400, { errors: [{ message: 'bad prompt' }] })).image('x'), /bad prompt/);
    await assert.rejects(new CloudflareMedia('a', 't', reply(200, { result: {} })).image('x'), /ninguna imagen/);
  });
});

describe('picture prompts are translated to English first', () => {
  const sent: { url: string; body: any }[] = [];
  const fake = (translation: unknown): Fetch => async (url, init) => {
    sent.push({ url, body: JSON.parse(init.body) });
    if (url.endsWith(TRANSLATE_MODEL)) return translation === 'fail' ? { ok: false, status: 500, text: async () => '{}' } : { ok: true, status: 200, text: async () => JSON.stringify({ result: { response: translation } }) };
    return { ok: true, status: 200, text: async () => JSON.stringify({ result: { image: '/9j/AAAA' } }) };
  };

  it('sends the English text to the picture model', async () => {
    sent.length = 0;
    await new CloudflareMedia('a', 't', fake('"Close-up of chocolate chip cookies on a rustic wooden table"')).image('Primer plano de galletas con chips sobre mesa de madera');
    assert.equal(sent[1]?.body.prompt, 'Close-up of chocolate chip cookies on a rustic wooden table');
    assert.match(sent[0]?.body.messages[1].content, /galletas/);
  });

  it('falls back to the original text when translating fails or answers nothing', async () => {
    sent.length = 0;
    await new CloudflareMedia('a', 't', fake('fail')).image('galletas');
    assert.equal(sent[1]?.body.prompt, 'galletas');
    sent.length = 0;
    await new CloudflareMedia('a', 't', fake('   ')).image('biscotti');
    assert.equal(sent[1]?.body.prompt, 'biscotti');
  });
});

describe('Cloudflare voice languages', () => {
  it('refuses Spanish and Italian up front: the service answers "Invalid input" to them', async () => {
    let called = false;
    const media = new CloudflareMedia('a', 't', async () => { called = true; return { ok: true, status: 200, text: async () => '{}' }; });
    await assert.rejects(media.voice('hola', 'es'), /GEMINI_API_KEY/);
    assert.equal(called, false);
  });
});

describe('Gemini voice', () => {
  const pcm = Buffer.from([1, 0, 2, 0, 3, 0]).toString('base64');
  const ok = (seen: { url?: string; headers?: Record<string, string>; body?: string }): Fetch => async (url, init) => {
    Object.assign(seen, { url, headers: init.headers, body: init.body });
    return { ok: true, status: 200, text: async () => JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;rate=24000', data: pcm } }] } }] }) };
  };

  it('asks for audio, sends the key in a header (not the URL) and returns a playable WAV', async () => {
    const seen: { url?: string; headers?: Record<string, string>; body?: string } = {};
    const out = await new GeminiVoice('secret-key', undefined, ok(seen)).speak('Ciao, benvenuti', 'it');
    assert.equal(out.mime, 'audio/wav');
    assert.equal(seen.url?.includes('secret-key'), false);
    assert.equal(seen.headers?.['x-goog-api-key'], 'secret-key');
    assert.match(seen.url ?? '', /models\/gemini-2\.5-flash-preview-tts:generateContent$/);
    assert.match(seen.body ?? '', /"responseModalities":\["AUDIO"\]/);
    const wav = Buffer.from(out.base64, 'base64');
    assert.equal(wav.subarray(0, 4).toString(), 'RIFF');
    assert.equal(wav.subarray(8, 12).toString(), 'WAVE');
    assert.equal(wav.length, 44 + 6);
    assert.equal(wav.readUInt32LE(24), 24000);
  });

  it('builds a correct WAV header', () => {
    const wav = Buffer.from(pcmToWavBase64(pcm), 'base64');
    assert.equal(wav.readUInt32LE(4), 36 + 6);
    assert.equal(wav.readUInt32LE(40), 6);
    assert.equal(wav.readUInt16LE(34), 16);
  });

  const reply = (status: number, body: unknown): Fetch => async () => ({ ok: status < 300, status, text: async () => JSON.stringify(body) });

  it('explains quota, unknown-model, rejected-request and empty answers', async () => {
    const speak = (f: Fetch) => new GeminiVoice('k', 'm', f).speak('x', 'es');
    await assert.rejects(speak(reply(429, {})), /cupo gratuito de voz/);
    await assert.rejects(speak(reply(404, {})), /GEMINI_TTS_MODEL/);
    await assert.rejects(speak(reply(400, { error: { message: 'API key not valid' } })), /API key not valid/);
    await assert.rejects(speak(reply(200, { candidates: [] })), /ningún audio/);
  });
});

describe('buildMedia', () => {
  it('uses Gemini for voice when it has a key, Cloudflare only for pictures', () => {
    const cf = new CloudflareMedia('a', 't');
    const media = buildMedia({ cloudflare: cf, gemini: new GeminiVoice('k') });
    assert.ok(media?.image);
    assert.deepEqual(media?.voice?.langs, ['es', 'it', 'en', 'fr', 'de', 'pt']);
  });
  it('falls back to Cloudflare voice (English and French only) without a Gemini key', () => {
    const media = buildMedia({ cloudflare: new CloudflareMedia('a', 't') });
    assert.deepEqual(media?.voice?.langs, ['en', 'fr']);
  });
  it('gives voice without pictures when only Gemini is configured, and nothing when neither is', () => {
    const onlyGemini = buildMedia({ gemini: new GeminiVoice('k') });
    assert.equal(onlyGemini?.image, null);
    assert.ok(onlyGemini?.voice);
    assert.equal(buildMedia({}), undefined);
  });
});
