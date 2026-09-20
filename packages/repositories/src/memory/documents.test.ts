import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createMemoryRepositories } from './index.ts';

const at = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s));

describe('document store (memory adapter)', () => {
  it('upserts by (kind, id) and keeps createdAt', async () => {
    const { documents } = createMemoryRepositories();
    await documents.put({ kind: 'plan', id: 'p1', missionId: 'm1', payload: { v: 1 }, at: at(1) });
    await documents.put({ kind: 'plan', id: 'p1', missionId: 'm1', payload: { v: 2 }, at: at(9) });

    const doc = await documents.get('plan', 'p1');
    assert.deepEqual(doc?.payload, { v: 2 });
    assert.equal(doc?.createdAt.getTime(), at(1).getTime());
    assert.equal(doc?.updatedAt.getTime(), at(9).getTime());
  });

  it('keeps the same id in different kinds apart', async () => {
    const { documents } = createMemoryRepositories();
    await documents.put({ kind: 'plan', id: 'x', payload: 'a', at: at(1) });
    await documents.put({ kind: 'qa', id: 'x', payload: 'b', at: at(2) });
    assert.equal((await documents.get('plan', 'x'))?.payload, 'a');
    assert.equal((await documents.get('qa', 'x'))?.payload, 'b');
  });

  it('filters by kind list, mission, run and scope, and orders and limits', async () => {
    const { documents } = createMemoryRepositories();
    await documents.put({ kind: 'audit', id: 'a1', missionId: 'm1', runId: 'r1', payload: 1, at: at(1) });
    await documents.put({ kind: 'audit', id: 'a2', missionId: 'm1', runId: 'r1', payload: 2, at: at(2) });
    await documents.put({ kind: 'audit', id: 'a3', missionId: 'm2', runId: 'r2', payload: 3, at: at(3) });
    await documents.put({ kind: 'memory', id: 'k1', scope: 'user', payload: 4, at: at(4) });

    assert.deepEqual((await documents.list({ kind: 'audit', missionId: 'm1' })).map((d) => d.id), ['a1', 'a2']);
    assert.deepEqual((await documents.list({ kind: 'audit', order: 'desc', limit: 2 })).map((d) => d.id), ['a3', 'a2']);
    assert.deepEqual((await documents.list({ kind: ['audit', 'memory'], runId: 'r2' })).map((d) => d.id), ['a3']);
    assert.deepEqual((await documents.list({ scope: 'user' })).map((d) => d.id), ['k1']);
  });

  it('breaks ties between documents written in the same instant by insertion order', async () => {
    const { documents } = createMemoryRepositories();
    for (const id of ['b', 'a', 'c']) await documents.put({ kind: 'audit', id, payload: id, at: at(5) });
    assert.deepEqual((await documents.list({ kind: 'audit' })).map((d) => d.id), ['b', 'a', 'c']);
  });

  it('returns copies, so callers cannot mutate stored state', async () => {
    const { documents } = createMemoryRepositories();
    const payload = { list: [1] };
    await documents.put({ kind: 'plan', id: 'p', payload, at: at(1) });
    payload.list.push(2);
    const first = await documents.get('plan', 'p');
    (first?.payload as { list: number[] }).list.push(3);
    assert.deepEqual((await documents.get('plan', 'p'))?.payload, { list: [1] });
  });

  it('removes documents', async () => {
    const { documents } = createMemoryRepositories();
    await documents.put({ kind: 'memory', id: 'k', payload: 1, at: at(1) });
    assert.equal(await documents.remove('memory', 'k'), true);
    assert.equal(await documents.remove('memory', 'k'), false);
    assert.equal(await documents.get('memory', 'k'), null);
  });
});
