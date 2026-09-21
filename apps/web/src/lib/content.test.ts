import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { bucketOf, groupContent, isoToLocalInput, localInputToIso, makeVideo, type ContentItem } from './content.ts';

const base: ContentItem = {
  id: '1', title: 't', caption: '', platform: 'instagram', status: 'scheduled', scheduledAt: null, publishedAt: null,
  imagePrompt: '', voiceText: '', hasImage: false, hasAudio: false, hasVideo: false, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
};
const NOW = Date.parse('2026-10-01T12:00:00Z');

describe('content buckets', () => {
  it('a scheduled item is due once its time has come, and upcoming before', () => {
    assert.equal(bucketOf({ ...base, scheduledAt: '2026-10-01T11:00:00Z' }, NOW), 'due');
    assert.equal(bucketOf({ ...base, scheduledAt: '2026-10-01T12:00:00Z' }, NOW), 'due');
    assert.equal(bucketOf({ ...base, scheduledAt: '2026-10-02T09:00:00Z' }, NOW), 'scheduled');
  });
  it('drafts and published items keep their own lists whatever the date', () => {
    assert.equal(bucketOf({ ...base, status: 'draft', scheduledAt: '2026-10-01T11:00:00Z' }, NOW), 'draft');
    assert.equal(bucketOf({ ...base, status: 'scheduled', scheduledAt: null }, NOW), 'draft');
    assert.equal(bucketOf({ ...base, status: 'published', scheduledAt: '2026-10-05T11:00:00Z' }, NOW), 'published');
  });
  it('groups items and lists the most recently published first', () => {
    const groups = groupContent(
      [
        { ...base, id: 'a', status: 'published', publishedAt: '2026-09-01T00:00:00Z' },
        { ...base, id: 'b', status: 'published', publishedAt: '2026-09-05T00:00:00Z' },
        { ...base, id: 'c', status: 'draft' },
      ],
      NOW,
    );
    assert.deepEqual(groups.published.map((i) => i.id), ['b', 'a']);
    assert.equal(groups.draft.length, 1);
  });
});

describe('date inputs', () => {
  it('an empty field means no date and a garbage one is ignored', () => {
    assert.equal(localInputToIso(''), null);
    assert.equal(localInputToIso('nope'), null);
  });
  it('round-trips a local date-time', () => {
    const iso = localInputToIso('2026-10-01T09:30');
    assert.ok(iso);
    assert.equal(isoToLocalInput(iso), '2026-10-01T09:30');
    assert.equal(isoToLocalInput(null), '');
  });
});

describe('makeVideo polling', () => {
  const realFetch = globalThis.fetch;
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const item = { id: '1', hasVideo: true } as ContentItem;
  const script = (answers: unknown[]) => {
    const calls: string[] = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (init?.method === 'POST') return reply(202, { job: { state: 'running' } });
      return reply(200, answers.shift());
    }) as typeof fetch;
    return calls;
  };

  it('starts the job, keeps asking while it runs, and returns the finished item', async () => {
    const calls = script([{ state: 'running', item }, { state: 'running', item }, { state: 'idle', message: null, item }]);
    try {
      assert.deepEqual(await makeVideo('1', () => true, 1), item);
      assert.equal(calls[0], 'POST /api/content/1/video');
      assert.equal(calls.length, 4);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('surfaces the server\'s reason when it fails, and explains a lost job', async () => {
    script([{ state: 'failed', message: 'No se pudo crear el vídeo: x.', item }]);
    try {
      await assert.rejects(makeVideo('1', () => true, 1), /No se pudo crear el vídeo: x/);
      script([{ state: 'idle', message: null, item: { ...item, hasVideo: false } }]);
      await assert.rejects(makeVideo('1', () => true, 1), /servidor se reinició/);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('stops asking once the screen is gone', async () => {
    script([]);
    try {
      await assert.rejects(makeVideo('1', () => false, 1), /Cancelado/);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
