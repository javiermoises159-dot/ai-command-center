import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { bucketOf, groupContent, isoToLocalInput, localInputToIso, type ContentItem } from './content.ts';

const base: ContentItem = {
  id: '1', title: 't', caption: '', platform: 'instagram', status: 'scheduled', scheduledAt: null, publishedAt: null,
  imagePrompt: '', voiceText: '', hasImage: false, hasAudio: false, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
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
