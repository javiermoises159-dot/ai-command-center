import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildMedia, chainImages, chainTranscribers, GeminiImage, GroqWhisper, HuggingFaceImage, MediaError, PollinationsImage, type ImageStep } from './media.ts';

const png = { mime: 'image/png', base64: 'aW1n' };
const step = (name: string, run: () => Promise<typeof png>): ImageStep => ({ name, run });

describe('chainImages', () => {
  it('uses the next service when one fails and says which ones failed when all do', async () => {
    const calls: string[] = [];
    const chain = chainImages([
      step('A', async () => { calls.push('A'); throw new MediaError('cupo', 429); }),
      step('B', async () => { calls.push('B'); throw new MediaError('roto'); }),
      step('C', async () => { calls.push('C'); return png; }),
    ]);
    assert.deepEqual(await chain('x'), png);
    assert.deepEqual(calls, ['A', 'B', 'C']);
    const failing = chainImages([step('A', async () => { throw new MediaError('cupo', 429); }), step('B', async () => { throw new MediaError('roto'); })]);
    await assert.rejects(failing('x'), (e: MediaError) => /A: cupo · B: roto/.test(e.message) && e.status === 502);
  });

  it('rests a service whose quota is spent instead of asking again, then tries it again later', async () => {
    let clock = 0;
    let a = 0;
    const chain = chainImages([step('A', async () => { a += 1; throw new MediaError('cupo', 429); }), step('B', async () => png)], { cooldownMs: 1000, now: () => clock });
    await chain('x');
    await chain('x');
    assert.equal(a, 1);
    clock = 2000;
    await chain('x');
    assert.equal(a, 2);
  });

  it('reports a quota error only when every service is out of quota', async () => {
    const chain = chainImages([step('A', async () => { throw new MediaError('cupo', 429); })]);
    await assert.rejects(chain('x'), (e: MediaError) => e.status === 429);
  });
});

describe('chainImages reasons and short cooldowns', () => {
  it('keeps the real reason of a resting service and lets a per-minute limit come back quickly', async () => {
    let clock = 0;
    let calls = 0;
    const chain = chainImages(
      [{ name: 'Rapido', cooldownMs: 20_000, run: async () => { calls += 1; throw new MediaError('demasiadas peticiones a la vez', 429); } }, { name: 'Diario', run: async () => { throw new MediaError('cupo diario', 429); } }],
      { now: () => clock },
    );
    await assert.rejects(chain('x'), /Rapido: demasiadas peticiones a la vez · Diario: cupo diario/);
    await assert.rejects(chain('x'), /Rapido: demasiadas peticiones a la vez \(se vuelve a probar en \d+ s\) · Diario: cupo diario \(se vuelve a probar en 30 min\)/);
    assert.equal(calls, 1);
    clock = 21_000;
    await assert.rejects(chain('x'));
    assert.equal(calls, 2);
  });
});

describe('Pollinations retries', () => {
  it('waits and asks again when it is busy (429) and gives up after three tries', async () => {
    let n = 0;
    const waits: number[] = [];
    const flaky = (async () => { n += 1; return n < 3 ? new Response('', { status: 429 }) : new Response(Buffer.alloc(2000, 1), { status: 200, headers: { 'content-type': 'image/jpeg' } }); }) as unknown as typeof fetch;
    const ok = await new PollinationsImage(flaky, async (ms) => { waits.push(ms); }).image('x');
    assert.equal(ok.mime, 'image/jpeg');
    assert.deepEqual(waits, [4000, 8000]);
    let m = 0;
    const always = (async () => { m += 1; return new Response('', { status: 429 }); }) as unknown as typeof fetch;
    await assert.rejects(new PollinationsImage(always, async () => undefined).image('x'), (e: MediaError) => e.status === 429);
    assert.equal(m, 3);
    let bad = 0;
    const notFound = (async () => { bad += 1; return new Response('', { status: 404 }); }) as unknown as typeof fetch;
    await assert.rejects(new PollinationsImage(notFound, async () => undefined).image('x'));
    assert.equal(bad, 1);
  });
});

describe('buildMedia backups', () => {
  it('falls back to the extra pictures when Cloudflare is out of quota, and works with no Cloudflare at all', async () => {
    const cloudflare = { image: async () => { throw new MediaError('cupo', 429); }, voice: async () => png } as never;
    const media = buildMedia({ cloudflare, extraImages: [step('Gratis', async () => png)] });
    assert.deepEqual(await media?.image?.('x'), png);
    assert.notEqual(buildMedia({ extraImages: [step('Gratis', async () => png)] })?.image, null);
    assert.equal(buildMedia({}), undefined);
  });

  it('uses Cloudflare voice when Gemini fails, but only for the languages it speaks', async () => {
    const gemini = { langs: ['es', 'en'], speak: async () => { throw new MediaError('cupo', 429); } } as never;
    const cloudflare = { image: async () => png, voice: async () => ({ mime: 'audio/mpeg', base64: 'YQ==' }) } as never;
    const voice = buildMedia({ gemini, cloudflare })?.voice;
    assert.equal((await voice?.speak('hi', 'en'))?.mime, 'audio/mpeg');
    await assert.rejects(voice?.speak('hola', 'es') as Promise<unknown>, /cupo/);
  });
});

describe('chainTranscribers', () => {
  it('tries the next service and is undefined when there is none', async () => {
    assert.equal(chainTranscribers([]), undefined);
    const t = chainTranscribers([
      { name: 'A', run: async () => { throw new MediaError('cupo'); } },
      { name: 'B', run: async () => [{ start: 0, end: 1, text: 'hola' }] },
    ]);
    assert.equal((await t?.({ mime: 'audio/mpeg', base64: '' }))?.[0]?.text, 'hola');
    await assert.rejects(chainTranscribers([{ name: 'A', run: async () => [] }])?.({ mime: 'audio/mpeg', base64: '' }) as Promise<unknown>, /A: no encontró palabras/);
  });
});

describe('backup picture services', () => {
  const reply = (status: number, body: string | Buffer, type: string) => (async () => new Response(body as never, { status, headers: { 'content-type': type } })) as unknown as typeof fetch;

  it('Gemini reads the inline picture and maps 429 to quota', async () => {
    const ok = reply(200, JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { data: 'AAAA', mimeType: 'image/png' } }] } }] }), 'application/json');
    assert.deepEqual(await new GeminiImage('k', 'm', ok).image('x'), { mime: 'image/png', base64: 'AAAA' });
    await assert.rejects(new GeminiImage('k', 'm', reply(429, '{}', 'application/json')).image('x'), (e: MediaError) => e.status === 429);
    await assert.rejects(new GeminiImage('k', 'm', reply(200, '{"candidates":[]}', 'application/json')).image('x'), /ninguna imagen/);
  });

  it('Pollinations and Hugging Face return the image bytes, reject non-images and never leak the token in errors', async () => {
    const bytes = Buffer.alloc(2000, 1);
    assert.equal((await new PollinationsImage(reply(200, bytes, 'image/jpeg')).image('x')).mime, 'image/jpeg');
    await assert.rejects(new PollinationsImage(reply(200, 'oops', 'text/html')).image('x'), /error 200/);
    assert.equal((await new HuggingFaceImage('SECRET', reply(200, bytes, 'image/jpeg')).image('x')).mime, 'image/jpeg');
    await assert.rejects(new HuggingFaceImage('SECRET', reply(401, '', 'text/plain')).image('x'), (e: Error) => !e.message.includes('SECRET'));
    await assert.rejects(new HuggingFaceImage('SECRET', reply(402, '', 'text/plain')).image('x'), (e: MediaError) => e.status === 429);
  });

  it('Groq Whisper keeps segments with timing', async () => {
    const ok = reply(200, JSON.stringify({ segments: [{ start: 0, end: 2, text: ' Hola ' }, { start: 2, end: 2, text: 'x' }] }), 'application/json');
    assert.deepEqual(await new GroqWhisper('k', ok).transcribe({ mime: 'audio/mpeg', base64: 'YQ==' }), [{ start: 0, end: 2, text: 'Hola' }]);
    await assert.rejects(new GroqWhisper('k', reply(429, '{}', 'application/json')).transcribe({ mime: 'audio/mpeg', base64: 'YQ==' }), (e: MediaError) => e.status === 429);
  });
});
