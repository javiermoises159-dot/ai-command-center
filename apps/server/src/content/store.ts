/**
 * Content calendar storage.
 *
 * Two implementations behind one interface: Postgres for real use, memory for
 * PERSISTENCE=memory and tests. Media (a generated picture or voice-over) is
 * stored with the item and only read by the media endpoint, never by listings.
 */

import { randomUUID } from 'node:crypto';

import type { ContentItem, ContentInput, ContentPatch, ContentStatus, ContentStore, Media, MediaKind, Platform } from '@acc/database';

export type { ContentItem, ContentInput, ContentPatch, ContentStatus, ContentStore, Media, MediaKind, Platform };
export const PLATFORMS = ['instagram', 'facebook', 'tiktok', 'youtube', 'telegram', 'other'] as const satisfies readonly Platform[];
export const STATUSES = ['draft', 'scheduled', 'published'] as const satisfies readonly ContentStatus[];

/** Publishing sets the date it happened; leaving "published" clears it. */
function publishedAtFor(status: ContentStatus, previous: string | null): string | null {
  if (status !== 'published') return null;
  return previous ?? new Date().toISOString();
}

export class MemoryContentStore implements ContentStore {
  private readonly items = new Map<string, { item: ContentItem; image: Media | null; audio: Media | null }>();

  async list(): Promise<ContentItem[]> {
    return [...this.items.values()].map((e) => e.item).sort(byDate);
  }
  async get(id: string): Promise<ContentItem | null> {
    return this.items.get(id)?.item ?? null;
  }
  async create(input: ContentInput): Promise<ContentItem> {
    const now = new Date().toISOString();
    const scheduledAt = input.scheduledAt ?? null;
    const item: ContentItem = {
      id: randomUUID(),
      title: input.title,
      caption: input.caption ?? '',
      platform: input.platform ?? 'instagram',
      status: scheduledAt === null ? 'draft' : 'scheduled',
      scheduledAt,
      publishedAt: null,
      imagePrompt: input.imagePrompt ?? '',
      voiceText: input.voiceText ?? '',
      hasImage: false,
      hasAudio: false,
      createdAt: now,
      updatedAt: now,
    };
    this.items.set(item.id, { item, image: null, audio: null });
    return item;
  }
  async update(id: string, patch: ContentPatch): Promise<ContentItem | null> {
    const entry = this.items.get(id);
    if (entry === undefined) return null;
    const next: ContentItem = { ...entry.item, ...definedOnly(patch), updatedAt: new Date().toISOString() };
    next.publishedAt = publishedAtFor(next.status, entry.item.publishedAt);
    entry.item = next;
    return next;
  }
  async delete(id: string): Promise<boolean> {
    return this.items.delete(id);
  }
  async setMedia(id: string, kind: MediaKind, media: Media): Promise<ContentItem | null> {
    const entry = this.items.get(id);
    if (entry === undefined) return null;
    if (kind === 'image') entry.image = media;
    else entry.audio = media;
    entry.item = { ...entry.item, hasImage: entry.image !== null, hasAudio: entry.audio !== null, updatedAt: new Date().toISOString() };
    return entry.item;
  }
  async getMedia(id: string, kind: MediaKind): Promise<Media | null> {
    const entry = this.items.get(id);
    return (kind === 'image' ? entry?.image : entry?.audio) ?? null;
  }
}

function definedOnly<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** Soonest first; items with no date go last, newest first. */
function byDate(a: ContentItem, b: ContentItem): number {
  if (a.scheduledAt !== null && b.scheduledAt !== null) return a.scheduledAt.localeCompare(b.scheduledAt);
  if (a.scheduledAt !== null) return -1;
  if (b.scheduledAt !== null) return 1;
  return b.createdAt.localeCompare(a.createdAt);
}

