import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { silentLogger } from '@acc/domain';
import type { MissionService } from '@acc/orchestrator';
import { ProviderRegistry } from '@acc/providers';

import { createRouter } from '../http/router.ts';
import { createClipMaker, parsePlan, srtFor, type ClipMaker } from './clips.ts';
import { MemoryContentStore } from './store.ts';
import { ffmpegAvailable } from './video.ts';

describe('parsePlan', () => {
  it('keeps clips that fit the video, clamps them and reads the flags', () => {
    const plan = parsePlan('```json\n{"clips":[{"start":-3,"end":20,"title":"A","caption":"x #a"},{"start":50,"end":200,"title":"B"},{"start":5,"end":5.5},{"start":"a","end":9}],"vertical":true,"captions":true}\n```', 100);
    assert.deepEqual(plan?.clips.map((c) => [c.start, c.end, c.title]), [[0, 20, 'A'], [50, 100, 'B']]);
    assert.equal(plan?.vertical, true);
    assert.equal(plan?.captions, true);
    assert.equal(plan?.mute, false);
  });
  it('caps a clip at 90 seconds and returns null for junk', () => {
    assert.equal(parsePlan('{"clips":[{"start":0,"end":500}]}', 600)?.clips[0]?.end, 90);
    assert.equal(parsePlan('nada', 60), null);
    assert.equal(parsePlan('{"clips":[]}', 60), null);
  });
});

describe('srtFor', () => {
  it('times captions from the clip start and drops segments outside it', () => {
    const srt = srtFor([{ start: 0, end: 4, text: 'fuera' }, { start: 10, end: 14, text: 'hola  mundo' }, { start: 30, end: 33, text: 'lejos' }], 9, 16);
    assert.match(srt, /00:00:01,000 --> 00:00:05,000\nhola mundo/);
    assert.equal(srt.includes('fuera'), false);
    assert.equal(srt.includes('lejos'), false);
    assert.equal(srtFor([], 0, 10), '');
  });
});

describe('createClipMaker (real ffmpeg)', { skip: !ffmpegAvailable() }, () => {
  function sourceVideo() {
    const dir = mkdtempSync(join(tmpdir(), 'acc-src-'));
    const file = join(dir, 'in.mp4');
    const made = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=10:duration=12', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=12', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file]);
    assert.equal(made.status, 0);
    return { mime: 'video/mp4', base64: readFileSync(file).toString('base64') };
  }
  const probe = (base64: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'acc-out-'));
    const file = join(dir, 'out.mp4');
    spawnSync('sh', ['-c', `cat > ${file}`], { input: Buffer.from(base64, 'base64') });
    const out = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height,codec_type:format=duration', '-of', 'json', file]).stdout.toString();
    return JSON.parse(out) as { format: { duration: string }; streams: { width?: number; height?: number; codec_type: string }[] };
  };

  it('cuts two vertical clips with burnt-in captions', async () => {
    const steps: string[] = [];
    const make = createClipMaker({
      plan: async () => ({ clips: [{ start: 1, end: 5, title: 'Uno', caption: 'c1' }, { start: 6, end: 10, title: 'Dos', caption: 'c2' }], vertical: true, captions: true, mute: false }),
      transcribe: async () => [{ start: 0, end: 5, text: 'Hola a todos' }, { start: 5, end: 12, text: 'Bienvenidos a CookieLab' }],
    });
    const out = await make({ video: sourceVideo(), request: 'dos clips', onStep: (s) => steps.push(s) });
    assert.equal(out.clips.length, 2);
    assert.deepEqual(out.notes, []);
    const info = probe(out.clips[0]!.video.base64);
    assert.ok(Math.abs(Number(info.format.duration) - 4) < 0.6);
    const v = info.streams.find((s) => s.codec_type === 'video');
    assert.deepEqual([v?.width, v?.height], [540, 960]);
    assert.ok(info.streams.some((s) => s.codec_type === 'audio'));
    assert.ok(steps.includes('Creando el clip 2 de 2'));
  });

  it('works without a transcriber, saying so, and can mute', async () => {
    const make = createClipMaker({ plan: async () => ({ clips: [{ start: 0, end: 3, title: 'Solo', caption: '' }], vertical: false, captions: true, mute: true }) });
    const out = await make({ video: sourceVideo(), request: 'recorta', onStep: () => undefined });
    assert.equal(out.clips.length, 1);
    assert.equal(out.notes.length, 2);
    assert.equal(probe(out.clips[0]!.video.base64).streams.some((s) => s.codec_type === 'audio'), false);
  });

  it('rejects a file that is not a video', async () => {
    const make = createClipMaker({ plan: async () => ({ clips: [], vertical: false, captions: false, mute: false }) });
    await assert.rejects(make({ video: { mime: 'video/mp4', base64: Buffer.from('nada').toString('base64') }, request: 'x', onStep: () => undefined }), /No se pudo leer el vídeo/);
  });
});

describe('video upload and edit routes', () => {
  function api(clips: ClipMaker | undefined) {
    const store = new MemoryContentStore();
    const router = createRouter({ missions: {} as MissionService, providers: new ProviderRegistry(), logger: silentLogger, version: 't', content: { store, media: undefined, clips } });
    return async (method: 'GET' | 'POST', path: string, body?: unknown) => {
      const res = await router.handle({ method, path, query: {}, body, headers: {} });
      return { status: res.status, body: res.body as any };
    };
  }
  const upload = (call: ReturnType<typeof api>) => call('POST', '/api/content/upload', { title: 'Mi vídeo', mime: 'video/quicktime', base64: Buffer.from('video').toString('base64') });

  it('stores an upload as a draft with its video, and refuses an empty or oversized one', async () => {
    const call = api(undefined);
    const res = await upload(call);
    assert.equal(res.status, 201);
    assert.equal(res.body.item.hasVideo, true);
    assert.equal(res.body.item.title, 'Vídeo original: Mi vídeo');
    assert.equal((await call('POST', '/api/content/upload', {})).status, 400);
    const big = 'A'.repeat(41 * 1024 * 1024);
    assert.equal((await call('POST', '/api/content/upload', { base64: big })).status, 400);
  });

  it('runs an edit in the background and saves every clip as a draft item', async () => {
    const call = api(async ({ onStep }) => {
      onStep('Cortando');
      return { clips: [{ title: 'Clip 1', caption: 'a', video: { mime: 'video/mp4', base64: 'dg==' } }, { title: 'Clip 2', caption: 'b', video: { mime: 'video/mp4', base64: 'dg==' } }], notes: ['nota'] };
    });
    const { body } = await upload(call);
    const started = await call('POST', `/api/content/${body.item.id}/edit`, { request: 'dos clips' });
    assert.equal(started.status, 202);
    await new Promise((r) => setTimeout(r, 20));
    const status = await call('GET', `/api/content/${body.item.id}/edit`);
    assert.equal(status.body.state, 'done');
    assert.deepEqual(status.body.items.map((i: any) => [i.title, i.hasVideo]), [['Clip 1', true], ['Clip 2', true]]);
    assert.deepEqual(status.body.notes, ['nota']);
  });

  it('reports a failed edit with its reason, and 409 when ffmpeg is missing', async () => {
    const failing = api(async () => { throw new Error('boom'); });
    const { body } = await upload(failing);
    await failing('POST', `/api/content/${body.item.id}/edit`, { request: 'x' });
    await new Promise((r) => setTimeout(r, 20));
    const status = await failing('GET', `/api/content/${body.item.id}/edit`);
    assert.equal(status.body.state, 'failed');
    assert.equal(status.body.message, 'boom');
    const none = api(undefined);
    const up = await upload(none);
    assert.equal((await none('POST', `/api/content/${up.body.item.id}/edit`, { request: 'x' })).status, 409);
  });
});
