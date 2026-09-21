import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { silentLogger } from '@acc/domain';
import type { MissionService } from '@acc/orchestrator';
import { ProviderRegistry } from '@acc/providers';

import { parseAssistantPlan, runAssistant, spreadDates, type AssistantPlanner } from './assistant.ts';
import { createRouter } from '../http/router.ts';
import { FacebookPublisher, TelegramPublisher, type Publisher } from './publish.ts';
import { MemoryContentStore } from './store.ts';

describe('parseAssistantPlan', () => {
  it('reads actions, clamps numbers and drops unknown or empty ones', () => {
    const plan = parseAssistantPlan('```json\n{"reply":"Hecho","actions":[{"type":"campaign","topic":"cookies","pieces":50,"days":0},{"type":"publish","target":"x"},{"type":"create","request":""},{"type":"create","request":"logo"}]}\n```');
    assert.equal(plan?.reply, 'Hecho');
    assert.deepEqual(plan?.actions, [{ type: 'campaign', topic: 'cookies', pieces: 7, days: 1 }, { type: 'create', request: 'logo' }]);
  });
  it('ignores video edits when nothing was uploaded, keeps a reply-only answer, and rejects junk', () => {
    assert.deepEqual(parseAssistantPlan('{"reply":"Sube un vídeo","actions":[{"type":"edit_video","request":"corta"}]}', { hasUploadedVideo: false })?.actions, []);
    assert.equal(parseAssistantPlan('{"reply":"No puedo hacer anuncios de pago","actions":[]}')?.actions.length, 0);
    assert.equal(parseAssistantPlan('nada'), null);
    assert.equal(parseAssistantPlan('{"actions":[]}'), null);
  });
  it('never has publishing among its actions', () => {
    assert.deepEqual(parseAssistantPlan('{"reply":"ok","actions":[{"type":"publish_telegram","request":"x"}]}')?.actions, []);
  });
});

describe('spreadDates and runAssistant', () => {
  it('spreads pieces from tomorrow to the last day', () => {
    const d = spreadDates(3, 15, new Date('2026-09-21T10:00:00Z'));
    assert.deepEqual(d, ['2026-09-22T18:00:00.000Z', '2026-09-29T18:00:00.000Z', '2026-10-06T18:00:00.000Z']);
    assert.deepEqual(spreadDates(1, 10, new Date('2026-09-21T10:00:00Z')), ['2026-09-22T18:00:00.000Z']);
  });
  it('runs every action in order and reports a failure without stopping the rest', async () => {
    const steps: string[] = [];
    const out = await runAssistant(
      { reply: '', actions: [{ type: 'create', request: 'a' }, { type: 'edit_video', request: 'b' }, { type: 'campaign', topic: 't', pieces: 3, days: 7 }] },
      {
        create: async () => ({ itemIds: ['1'], notes: [] }),
        editLatestVideo: async () => { throw new Error('no hay vídeo'); },
        campaign: async () => ({ itemIds: ['2', '3'], notes: ['n'] }),
      },
      (s) => steps.push(s),
    );
    assert.deepEqual(out.itemIds, ['1', '2', '3']);
    assert.equal(out.notes.length, 2);
    assert.match(out.notes[0] ?? '', /Paso 2 de 3 falló: no hay vídeo/);
    assert.equal(steps.length, 3);
  });
});

describe('assistant and publish routes', () => {
  function api(planner: AssistantPlanner | undefined, publishers: Publisher[] = [], image: () => Promise<{ mime: string; base64: string }> = async () => ({ mime: 'image/png', base64: 'aW1n' })) {
    const store = new MemoryContentStore();
    const media = { image, voice: null };
    const drafter = async () => [{ title: 'Uno', caption: 'a', imagePrompt: 'p1' }, { title: 'Dos', caption: 'b', imagePrompt: 'p2' }, { title: 'Tres', caption: 'c' }];
    const router = createRouter({ missions: {} as MissionService, providers: new ProviderRegistry(), logger: silentLogger, version: 't', content: { store, media, drafter, assistant: planner, publishers, imagePause: async () => undefined } });
    return {
      store,
      call: async (method: 'GET' | 'POST', path: string, body?: unknown) => {
        const res = await router.handle({ method, path, query: {}, body, headers: {} });
        return { status: res.status, body: res.body as any };
      },
    };
  }
  const wait = () => new Promise((r) => setTimeout(r, 30));

  it('a campaign request creates dated drafts with pictures, and publishes nothing', async () => {
    const { call, store } = api(async () => ({ reply: 'Preparo la campaña', actions: [{ type: 'campaign', topic: 'cookies en Turín', pieces: 3, days: 10 }] }));
    const started = await call('POST', '/api/assistant', { request: 'campaña de 10 días' });
    assert.equal(started.status, 202);
    await wait();
    const done = await call('GET', `/api/assistant/${started.body.id}`);
    assert.equal(done.body.state, 'done');
    assert.equal(done.body.reply, 'Preparo la campaña');
    assert.equal(done.body.items.length, 3);
    assert.deepEqual(done.body.items.map((i: any) => i.hasImage), [true, true, false]);
    const all = await store.list();
    assert.ok(all.every((i) => i.status === 'scheduled' && i.scheduledAt !== null));
  });

  it('retries missing pictures once after a pause and notes only the ones that still fail', async () => {
    let calls = 0;
    const { call } = api(async () => ({ reply: 'ok', actions: [{ type: 'campaign', topic: 't', pieces: 3, days: 5 }] }), [], async () => {
      calls += 1;
      if (calls <= 2 || calls === 4) throw new Error('ocupado');
      return { mime: 'image/png', base64: 'aW1n' };
    });
    const started = await call('POST', '/api/assistant', { request: 'campaña' });
    await wait();
    const done = await call('GET', `/api/assistant/${started.body.id}`);
    assert.deepEqual(done.body.items.map((i: any) => i.hasImage), [true, false, false]);
  });

  it('answers 409 without a real AI, 404 for an unknown job and reports a planner failure', async () => {
    assert.equal((await api(undefined).call('POST', '/api/assistant', { request: 'x' })).status, 409);
    assert.equal((await api(async () => ({ reply: '', actions: [] })).call('GET', '/api/assistant/nope')).status, 404);
    const failing = api(async () => { throw new Error('sin cuota'); });
    const { body } = await failing.call('POST', '/api/assistant', { request: 'x' });
    await wait();
    const status = await failing.call('GET', `/api/assistant/${body.id}`);
    assert.equal(status.body.state, 'failed');
    assert.match(status.body.message, /sin cuota/);
  });

  it('publishes only to a connected network, with the piece\'s media, and marks it published', async () => {
    const sent: unknown[] = [];
    const fake: Publisher = { target: 'telegram', label: 'Telegram', publish: async (i) => { sent.push(i); return { target: 'telegram', sent: 'image', id: '7' }; } };
    const { call, store } = api(undefined, [fake]);
    const item = await store.create({ title: 'T', caption: 'Texto' });
    await store.setMedia(item.id, 'image', { mime: 'image/png', base64: 'aW1n' });
    assert.equal((await call('POST', `/api/content/${item.id}/publish`, { target: 'facebook' })).status, 400);
    const ok = await call('POST', `/api/content/${item.id}/publish`, { target: 'telegram' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.item.status, 'published');
    assert.equal((sent[0] as any).caption, 'Texto');
    assert.equal((sent[0] as any).image.base64, 'aW1n');
    const status = await call('GET', '/api/content/status');
    assert.deepEqual(status.body.publishers, [{ target: 'telegram', label: 'Telegram' }]);
  });

  it('a failed publish leaves the piece as it was', async () => {
    const boom: Publisher = { target: 'telegram', label: 'Telegram', publish: async () => { throw new Error('rechazado'); } };
    const { call, store } = api(undefined, [boom]);
    const item = await store.create({ title: 'T' });
    assert.notEqual((await call('POST', `/api/content/${item.id}/publish`, { target: 'telegram' })).status, 200);
    assert.equal((await store.get(item.id))?.status, 'draft');
  });
});

describe('Telegram and Facebook publishers', () => {
  const capture = () => {
    const calls: { url: string; form: FormData }[] = [];
    const fetchImpl = (async (url: string, init: { body: FormData }) => {
      calls.push({ url, form: init.body });
      return new Response(JSON.stringify(url.includes('telegram') ? { ok: true, result: { message_id: 42 } } : { id: '123_456' }), { status: 200 });
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  };
  const img = { mime: 'image/png', base64: 'aW1n' };
  const vid = { mime: 'video/mp4', base64: 'dmlk' };

  it('Telegram sends the video if there is one, else the picture, else text; long captions follow as a message', async () => {
    const { calls, fetchImpl } = capture();
    const t = new TelegramPublisher('TOK', '@canal', fetchImpl);
    assert.equal((await t.publish({ caption: 'hola', image: img, audio: null, video: vid })).sent, 'video');
    assert.match(calls[0]!.url, /sendVideo$/);
    assert.equal(calls[0]!.form.get('caption'), 'hola');
    assert.equal((await t.publish({ caption: 'x'.repeat(1500), image: img, audio: null, video: null })).sent, 'image');
    assert.match(calls[1]!.url, /sendPhoto$/);
    assert.match(calls[2]!.url, /sendMessage$/);
    assert.equal(calls[1]!.form.get('caption'), null);
    assert.deepEqual((await t.publish({ caption: 'solo texto', image: null, audio: null, video: null })).id, '42');
  });

  it('Telegram errors never contain the bot token', async () => {
    const t = new TelegramPublisher('SECRET-TOKEN', '@c', (async () => { throw new Error('connect ECONNREFUSED https://api.telegram.org/botSECRET-TOKEN/x'); }) as unknown as typeof fetch);
    await assert.rejects(t.publish({ caption: 'x', image: null, audio: null, video: null }), (e: Error) => !e.message.includes('SECRET-TOKEN'));
    const bad = new TelegramPublisher('SECRET-TOKEN', '@c', (async () => new Response(JSON.stringify({ ok: false, description: 'Bad Request: chat not found' }), { status: 400 })) as unknown as typeof fetch);
    await assert.rejects(bad.publish({ caption: 'x', image: null, audio: null, video: null }), /TELEGRAM_CHAT_ID/);
  });

  it('Facebook posts a photo, a video or text to the page, and explains an expired token', async () => {
    const { calls, fetchImpl } = capture();
    const f = new FacebookPublisher('PAGE', 'TOK', fetchImpl);
    await f.publish({ caption: 'c', image: img, audio: null, video: null });
    await f.publish({ caption: 'c', image: img, audio: null, video: vid });
    await f.publish({ caption: 'c', image: null, audio: null, video: null });
    assert.deepEqual(calls.map((c) => c.url.split('/').slice(-1)[0]), ['photos', 'videos', 'feed']);
    const expired = new FacebookPublisher('PAGE', 'TOK', (async () => new Response(JSON.stringify({ error: { code: 190, message: 'expired' } }), { status: 400 })) as unknown as typeof fetch);
    await assert.rejects(expired.publish({ caption: 'c', image: null, audio: null, video: null }), /FACEBOOK_PAGE_TOKEN/);
  });
});
