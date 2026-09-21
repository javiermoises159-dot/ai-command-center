import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { silentLogger, type AIProvider, type ProviderId, type ProviderResult, type ProviderTask } from '@acc/domain';
import type { MissionService } from '@acc/orchestrator';
import { ProviderRegistry } from '@acc/providers';

import { createRouter } from '../http/router.ts';
import { createPieceDrafter, parsePieces, reportForDrafting } from './draft.ts';
import { MemoryContentStore } from './store.ts';

const GOOD = JSON.stringify({
  pieces: [
    { title: 'Presentazione', platform: 'instagram', caption: 'Biscotti artigianali a Torino #cookielab', voiceText: 'Ciao! Siamo CookieLab.', imagePrompt: 'Primo piano di biscotti al cioccolato' },
    { title: 'Fiducia', platform: 'facebook', caption: 'Ingredienti genuini.', voiceText: '', imagePrompt: '' },
  ],
});

function fake(id: ProviderId, behaviour: () => string | Error, seen: ProviderTask[] = []): AIProvider {
  return {
    id,
    label: `IA ${id}`,
    availability: 'available',
    listModels: () => [{ id: `${id}-model`, label: id }],
    execute: async (task): Promise<ProviderResult> => {
      seen.push(task);
      const out = behaviour();
      if (out instanceof Error) throw out;
      return { provider: id, model: task.model, text: out, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, requestId: 'r', finishReason: 'stop', latencyMs: 1, source: 'real', simulated: false };
    },
  };
}

describe('parsePieces', () => {
  it('reads the pieces out of plain JSON, code fences and surrounding chatter', () => {
    assert.equal(parsePieces(GOOD).length, 2);
    assert.equal(parsePieces('Claro, aquí tienes:\n```json\n' + GOOD + '\n```\nSuerte').length, 2);
  });
  it('drops entries without a title or without any text, and defaults an unknown platform', () => {
    const out = parsePieces(JSON.stringify({ pieces: [{ title: '', caption: 'x' }, { title: 'a' }, { title: 'ok', platform: 'myspace', caption: 'hola' }] }));
    assert.deepEqual(out.map((p) => [p.title, p.platform]), [['ok', 'instagram']]);
  });
  it('clips over-long fields to what the calendar accepts and returns nothing for junk', () => {
    const [piece] = parsePieces(JSON.stringify({ pieces: [{ title: 't'.repeat(500), caption: 'c'.repeat(9000), voiceText: 'v'.repeat(9000) }] }));
    assert.equal(piece?.title.length, 120);
    assert.equal(piece?.caption?.length, 4000);
    assert.equal(piece?.voiceText?.length, 1500);
    assert.deepEqual(parsePieces('sin json'), []);
    assert.deepEqual(parsePieces('{"pieces": "no"}'), []);
    assert.deepEqual(parsePieces('{roto'), []);
  });
});

describe('reportForDrafting', () => {
  it('removes embedded code (the whole web page) and caps the length', () => {
    const out = reportForDrafting('# Informe\n\ntexto útil\n\n```html\n<html>' + 'x'.repeat(50_000) + '</html>\n```\n\nfin');
    assert.match(out, /texto útil/);
    assert.match(out, /fin/);
    assert.equal(out.includes('<html>'), false);
    assert.ok(reportForDrafting('a'.repeat(50_000)).length <= 12_000);
  });
});

describe('createPieceDrafter', () => {
  it('moves on to the next provider when one fails or answers with junk', async () => {
    const seen: ProviderTask[] = [];
    const registry = new ProviderRegistry()
      .register(fake('gemini', () => new Error('cuota'), seen))
      .register(fake('cerebras', () => 'no sé'))
      .register(fake('mistral', () => GOOD));
    const pieces = await createPieceDrafter(registry)('Informe de la campaña de CookieLab');
    assert.equal(pieces.length, 2);
    assert.match(seen[0]?.systemPrompt ?? '', /No inventes precios/);
    assert.match(seen[0]?.systemPrompt ?? '', /VOZ \(como si el dueño/); // human voice, not brochure copy
    assert.match(seen[0]?.prompt ?? '', /CookieLab/);
  });

  it('says why when every provider fails, and refuses when only the simulator is present', async () => {
    const failing = new ProviderRegistry().register(fake('gemini', () => new Error('sin cuota')));
    await assert.rejects(createPieceDrafter(failing)('informe'), /IA gemini: sin cuota/);
    const onlyMock = new ProviderRegistry().register(fake('mock', () => GOOD));
    await assert.rejects(createPieceDrafter(onlyMock)('informe'), /ninguna IA real/);
    await assert.rejects(createPieceDrafter(failing)('   '), /no tiene informe/);
  });
});

describe('POST /api/missions/:id/content', () => {
  function api(finalResults: (string | null)[], text: () => string | Error) {
    const store = new MemoryContentStore();
    const missions = {
      get: async () => ({ mission: { id: 'm1', title: 'Campaña' }, runs: finalResults.map((finalResult, i) => ({ run: { attempt: i + 1, finalResult }, agents: [] })) }),
    } as unknown as MissionService;
    const providers = new ProviderRegistry().register(fake('gemini', text));
    const router = createRouter({ missions, providers, logger: silentLogger, version: 't', content: { store, media: undefined, drafter: createPieceDrafter(providers) } });
    return {
      store,
      call: async (method: 'GET' | 'POST', path: string) => {
        const res = await router.handle({ method, path, query: {}, body: undefined, headers: {} });
        return { status: res.status, body: res.body as any };
      },
    };
  }

  it('creates the pieces as undated drafts, from the newest run that has a report', async () => {
    const { call, store } = api(['# Informe viejo', '# Informe nuevo', null], () => GOOD);
    const res = await call('POST', '/api/missions/m1/content');
    assert.equal(res.status, 201);
    assert.equal(res.body.items.length, 2);
    const stored = await store.list();
    assert.deepEqual(stored.map((i) => i.status), ['draft', 'draft']);
    assert.ok(stored.every((i) => i.scheduledAt === null));
  });

  it('answers 404 when there is no report and 502 with the reason when the AI cannot help', async () => {
    assert.equal((await api([null], () => GOOD).call('POST', '/api/missions/m1/content')).status, 404);
    const bad = await api(['# Informe'], () => new Error('sin cuota')).call('POST', '/api/missions/m1/content');
    assert.equal(bad.status, 502);
    assert.match(JSON.stringify(bad.body), /sin cuota/);
  });
});
