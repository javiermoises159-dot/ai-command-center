import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildBrief, checkClaims, findContradictions, notConnectedSearch, research, SearchNotConnectedError, sourceWeight, type Claim, type Source } from './engine.ts';

const now = new Date('2026-09-19T00:00:00Z');
const src = (id: string, kind: Source['kind'], text: string, publishedAt: string | null = '2026-01-01'): Source => ({ id, title: `Source ${id}`, url: `https://${id}.example.test/x`, kind, publishedAt, text });

describe('research engine', () => {
  const sources = [src('a', 'official', 'The registry lists 1,200 bakeries in the region.'), src('b', 'news', 'Analysts count around 1,900 bakeries.')];

  it('keeps a FACT only when its quotation appears in the source', () => {
    const [ok, bad, ghost] = checkClaims([
      { id: 'c1', statement: 'There are 1,200 bakeries', label: 'FACT', citations: [{ sourceId: 'a', quote: 'lists 1,200 bakeries' }] },
      { id: 'c2', statement: 'There are 5,000 bakeries', label: 'FACT', citations: [{ sourceId: 'a', quote: '5,000 bakeries' }] },
      { id: 'c3', statement: 'x', label: 'FACT', citations: [{ sourceId: 'zzz', quote: 'q' }] },
    ], sources);
    assert.equal(ok?.label, 'FACT');
    assert.equal(bad?.label, 'ASSUMPTION');
    assert.equal(bad?.originalLabel, 'FACT');
    assert.match(bad?.issues.join(' ') ?? '', /La cita textual no aparece/);
    assert.equal(ghost?.label, 'ASSUMPTION');
    assert.match(ghost?.issues.join(' ') ?? '', /fuente desconocida/);
  });

  it('flags analysis with no basis', () => {
    const [c] = checkClaims([{ id: 'c', statement: 's', label: 'ANALYSIS', citations: [] }], sources);
    assert.ok(c?.issues.some((i) => /no indica en qué afirmaciones se basa/.test(i)));
  });

  it('detects contradictions between sources instead of choosing one', () => {
    const claims: Claim[] = [
      { id: 'c1', statement: '1,200', label: 'FACT', citations: [], topic: 'bakeries', value: 1200 },
      { id: 'c2', statement: '1,900', label: 'FACT', citations: [], topic: 'bakeries', value: 1900 },
      { id: 'c3', statement: 'close', label: 'FACT', citations: [], topic: 'shops', value: 100 },
      { id: 'c4', statement: 'close', label: 'FACT', citations: [], topic: 'shops', value: 104 },
    ];
    const found = findContradictions(claims);
    assert.equal(found.length, 1);
    assert.equal(found[0]?.topic, 'bakeries');
    assert.deepEqual(found[0]?.claimIds, ['c1', 'c2']);
  });

  it('weights sources by kind and age', () => {
    assert.ok(sourceWeight(src('a', 'primary', ''), now) > sourceWeight(src('b', 'social', ''), now));
    assert.ok(sourceWeight(src('a', 'news', '', '2018-01-01'), now) < sourceWeight(src('b', 'news', '', '2026-06-01'), now));
    assert.ok(sourceWeight(src('a', 'news', '', null), now) < sourceWeight(src('b', 'news', '', '2026-06-01'), now));
  });

  it('builds a brief that says nothing was searched and lists unknowns', () => {
    const b = buildBrief({ question: 'How many bakeries?', now, sources, claims: [
      { id: 'c1', statement: 'There are 1,200 bakeries', label: 'FACT', citations: [{ sourceId: 'a', quote: 'lists 1,200 bakeries' }] },
      { id: 'c2', statement: 'Online share of sales', label: 'UNKNOWN', citations: [] },
    ] });
    assert.equal(b.status, 'sourced');
    assert.match(b.markdown, /No se ha ejecutado ninguna búsqueda/);
    assert.match(b.markdown, /## Fuentes/);
    assert.deepEqual(b.unknowns, ['Online share of sales']);
    assert.match(b.markdown, /\[a\]/);
  });

  it('is unsourced with no facts', () => {
    assert.equal(buildBrief({ question: 'q', now, sources: [], claims: [{ id: 'c', statement: 's', label: 'ASSUMPTION', citations: [] }] }).status, 'unsourced');
  });

  it('search port is NOT CONNECTED and research still answers honestly', async () => {
    assert.equal(notConnectedSearch.connected, false);
    await assert.rejects(() => notConnectedSearch.search('x'), SearchNotConnectedError);
    const r = await research({ question: 'q', search: notConnectedSearch, now });
    assert.equal(r.searched, false);
    assert.match(r.searchError ?? '', /NO ESTÁ CONECTADA/);
    assert.equal(r.sources.length, 0);
  });

  it('uses a connected search provider and reports its failures', async () => {
    const good = { id: 's', connected: true, search: async () => [src('n', 'news', 'text')] };
    assert.equal((await research({ question: 'q', search: good, now })).sources.length, 1);
    const bad = { id: 's', connected: true, search: async () => { throw new Error('boom'); } };
    const r = await research({ question: 'q', search: bad, now });
    assert.equal(r.searchError, 'boom');
    assert.equal(r.searched, false);
  });
});
