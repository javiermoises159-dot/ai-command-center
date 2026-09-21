import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { silentLogger } from '@acc/domain';
import type { MissionService } from '@acc/orchestrator';
import { ProviderRegistry } from '@acc/providers';

import { createRouter } from '../http/router.ts';
import { pcmToWavBase64, type MediaGenerator } from './media.ts';
import { MemoryContentStore } from './store.ts';
import { captionsFor, createReelMaker, ffmpegAvailable, findFont, wrap, type ReelMaker } from './video.ts';

describe('captions', () => {
  it('wraps words to the screen width without cutting them', () => {
    assert.deepEqual(wrap('Biscotti artigianali appena sfornati a Torino', 22), ['Biscotti artigianali', 'appena sfornati a', 'Torino']);
    assert.deepEqual(wrap('supercalifragilisticexpialidocious ok', 10), ['supercalifragilisticexpialidocious', 'ok']);
    assert.deepEqual(wrap('   '), []);
  });

  it('times one block per sentence across the audio, in proportion to length, with no gaps', () => {
    const caps = captionsFor('Hola. Esto es una frase bastante más larga que la primera.', 10);
    assert.equal(caps.length, 2);
    assert.equal(caps[0]?.start, 0);
    assert.equal(caps[0]?.end, caps[1]?.start);
    assert.equal(caps[1]?.end, 10);
    assert.ok((caps[0]?.end ?? 0) < (caps[1]?.end ?? 0) - (caps[0]?.end ?? 0), 'the short sentence gets less time');
  });

  it('splits a sentence too long for the screen into several blocks of at most four lines', () => {
    const long = Array.from({ length: 40 }, (_, i) => `palabra${i}`).join(' ');
    const caps = captionsFor(long, 30);
    assert.ok(caps.length > 1);
    for (const c of caps) assert.ok(c.text.split('\n').length <= 4);
  });

  it('gives no captions for empty text or no time', () => {
    assert.deepEqual(captionsFor('   ', 5), []);
    assert.deepEqual(captionsFor('Hola', 0), []);
  });
});

const tools = ffmpegAvailable() && spawnSync('ffprobe', ['-version']).status === 0;

describe('reel maker (real ffmpeg)', { skip: tools ? false : 'ffmpeg/ffprobe not installed' }, () => {
  it('makes a 720x1280 mp4 as long as the voice, with audio', async () => {
    assert.ok(findFont() !== null, 'a caption font is installed (fonts-dejavu-core in the Docker image)');
    const dir = mkdtempSync(join(tmpdir(), 'acc-video-test-'));
    try {
      const png = join(dir, 'in.png');
      execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=orange:s=640x640', '-frames:v', '1', png]);
      // 2 seconds of silence as 24 kHz 16-bit mono PCM, wrapped the way Gemini's answer is.
      const wav = pcmToWavBase64(Buffer.alloc(24_000 * 2 * 2).toString('base64'));
      const make = createReelMaker();
      const video = await make({
        image: { mime: 'image/png', base64: readFileSync(png).toString('base64') },
        audio: { mime: 'audio/wav', base64: wav },
        text: 'Ciao, benvenuti da CookieLab. Biscotti artigianali appena sfornati.',
      });
      assert.equal(video.mime, 'video/mp4');
      const out = join(dir, 'out.mp4');
      writeFileSync(out, Buffer.from(video.base64, 'base64'));
      const info = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,width,height:format=duration', '-of', 'json', out]).toString());
      const v = info.streams.find((s: any) => s.codec_type === 'video');
      assert.equal(v.width, 720);
      assert.equal(v.height, 1280);
      assert.ok(info.streams.some((s: any) => s.codec_type === 'audio'));
      assert.ok(Math.abs(Number(info.format.duration) - 2) < 0.3, `duration ${info.format.duration}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('says so in plain words when the audio is not audio', async () => {
    const png = execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=64x64', '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png', '-']);
    await assert.rejects(
      createReelMaker()({ image: { mime: 'image/png', base64: png.toString('base64') }, audio: { mime: 'audio/wav', base64: Buffer.from('not audio').toString('base64') }, text: 'x' }),
      /voz/,
    );
  });
});

describe('POST /api/content/:id/video', () => {
  const media: MediaGenerator = {
    image: async () => ({ mime: 'image/png', base64: 'AAAA' }),
    voice: { langs: ['es'], speak: async () => ({ mime: 'audio/wav', base64: 'BBBB' }) },
  };
  function api(video: ReelMaker | undefined) {
    const router = createRouter({ missions: {} as MissionService, providers: new ProviderRegistry(), logger: silentLogger, version: 't', content: { store: new MemoryContentStore(), media, video } });
    return async (method: 'GET' | 'POST', path: string, body?: unknown) => {
      const res = await router.handle({ method, path, query: {}, body, headers: {} });
      return { status: res.status, body: res.body as any };
    };
  }

  it('needs the picture and the voice first, then stores the video and serves it', async () => {
    let received: any;
    const call = api(async (input) => {
      received = input;
      return { mime: 'video/mp4', base64: 'VIDEO' };
    });
    const { item } = (await call('POST', '/api/content', { title: 'X', imagePrompt: 'a', voiceText: 'Hola mundo.' })).body;
    assert.equal((await call('POST', `/api/content/${item.id}/video`)).status, 400);
    await call('POST', `/api/content/${item.id}/image`, {});
    assert.equal((await call('POST', `/api/content/${item.id}/video`)).status, 400, 'still no voice');
    await call('POST', `/api/content/${item.id}/voice`, { lang: 'es' });
    const done = await call('POST', `/api/content/${item.id}/video`);
    assert.equal(done.status, 200);
    assert.equal(done.body.item.hasVideo, true);
    assert.equal(received.text, 'Hola mundo.');
    assert.deepEqual((await call('GET', `/api/content/${item.id}/media/video`)).body, { mime: 'video/mp4', base64: 'VIDEO' });
    assert.equal((await call('GET', '/api/content/status')).body.media.video, true);
  });

  it('says ffmpeg is missing when it is', async () => {
    const call = api(undefined);
    const { item } = (await call('POST', '/api/content', { title: 'X' })).body;
    const res = await call('POST', `/api/content/${item.id}/video`);
    assert.equal(res.status, 409);
    assert.match(JSON.stringify(res.body), /ffmpeg/);
    assert.equal((await call('GET', '/api/content/status')).body.media.video, false);
  });
});
