import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { silentLogger, type AIProvider, type ProviderId, type ProviderResult } from '@acc/domain';
import type { MissionService } from '@acc/orchestrator';
import { ProviderRegistry } from '@acc/providers';

import { createRouter } from '../http/router.ts';
import { createStudioBriefer, parseBrief } from './studio.ts';
import { MemoryContentStore } from './store.ts';

const LOGO = JSON.stringify({ wants: ['image'], title: 'Logo CookieLab', platform: 'instagram', caption: '', voiceText: '', imagePrompt: 'flat vector cookie emblem', lang: 'it' });
const REEL = JSON.stringify({ wants: ['video'], title: 'Reel', platform: 'tiktok', caption: 'Ciao #cookies', voiceText: 'Ciao a tutti!', imagePrompt: 'cookies on a table', lang: 'it' });

function fake(id: ProviderId, out: () => string | Error): AIProvider {
  return {
    id, label: `IA ${id}`, availability: 'available', listModels: () => [{ id: 'm', label: 'm' }],
    execute: async (task): Promise<ProviderResult> => {
      const v = out();
      if (v instanceof Error) throw v;
      return { provider: id, model: task.model, text: v, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, requestId: 'r', finishReason: 'stop', latencyMs: 1, source: 'real', simulated: false };
    },
  };
}

describe('parseBrief', () => {
  it('reads a logo brief and a video brief (a video always needs picture and voice)', () => {
    assert.deepEqual(parseBrief(LOGO)?.wants, ['image']);
    assert.deepEqual(parseBrief('```json\n' + REEL + '\n```')?.wants, ['image', 'voice', 'video']);
    assert.equal(parseBrief(LOGO)?.lang, 'it');
  });
  it('rejects answers without the text needed to generate what was asked', () => {
    assert.equal(parseBrief(JSON.stringify({ wants: ['image'], imagePrompt: '' })), null);
    assert.equal(parseBrief(JSON.stringify({ wants: ['video'], imagePrompt: 'x', voiceText: '' })), null);
    assert.equal(parseBrief('no json'), null);
  });
});

describe('POST /api/content/studio', () => {
  function api(answer: () => string | Error, opts: { video?: boolean } = {}) {
    const store = new MemoryContentStore();
    const providers = new ProviderRegistry().register(fake('gemini', answer));
    const media = {
      image: async () => ({ mime: 'image/png', base64: 'aW1n' }),
      voice: { langs: ['es', 'it'] as ('es' | 'it')[], speak: async () => ({ mime: 'audio/wav', base64: 'YXVk' }) },
    };
    const video = opts.video === true ? async () => ({ mime: 'video/mp4', base64: 'dmlk' }) : undefined;
    const router = createRouter({ missions: {} as MissionService, providers, logger: silentLogger, version: 't', content: { store, media: media as never, video, studio: createStudioBriefer(providers) } });
    return async (method: 'GET' | 'POST', path: string, body?: unknown) => {
      const res = await router.handle({ method, path, query: {}, body, headers: {} });
      return { status: res.status, body: res.body as any };
    };
  }

  it('makes a logo: a draft with a real picture and nothing else', async () => {
    const call = api(() => LOGO);
    const res = await call('POST', '/api/content/studio', { request: 'un logo para mi tienda' });
    assert.equal(res.status, 201);
    assert.equal(res.body.item.hasImage, true);
    assert.equal(res.body.item.hasAudio, false);
    assert.equal(res.body.item.status, 'draft');
    assert.deepEqual(res.body.notes, []);
  });

  it('makes a reel: picture, voice in the asked language and a video job that finishes', async () => {
    const call = api(() => REEL, { video: true });
    const res = await call('POST', '/api/content/studio', { request: 'un reel' });
    assert.equal(res.body.videoStarted, true);
    assert.equal(res.body.item.hasAudio, true);
    await new Promise((r) => setTimeout(r, 20));
    const status = await call('GET', `/api/content/${res.body.item.id}/video`);
    assert.equal(status.body.item.hasVideo, true);
  });

  it('asks for a request and says why when the AI cannot help', async () => {
    assert.equal((await api(() => LOGO)('POST', '/api/content/studio', { request: '  ' })).status, 400);
    const bad = await api(() => new Error('sin cuota'))('POST', '/api/content/studio', { request: 'logo' });
    assert.equal(bad.status, 502);
    assert.match(JSON.stringify(bad.body), /sin cuota/);
  });
});
