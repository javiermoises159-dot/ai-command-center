/**
 * Content calendar: types and the Postgres store.
 *
 * Media (a generated picture or voice-over) is stored with the item and only
 * read by the media endpoint, never by listings.
 */

import type pg from 'pg';

export type Platform = 'instagram' | 'facebook' | 'tiktok' | 'youtube' | 'telegram' | 'other';
export type ContentStatus = 'draft' | 'scheduled' | 'published';
export type MediaKind = 'image' | 'audio' | 'video';

export interface ContentItem {
  id: string;
  title: string;
  caption: string;
  platform: Platform;
  status: ContentStatus;
  scheduledAt: string | null;
  publishedAt: string | null;
  imagePrompt: string;
  voiceText: string;
  hasImage: boolean;
  hasAudio: boolean;
  hasVideo: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ContentInput {
  title: string;
  caption?: string;
  platform?: Platform;
  scheduledAt?: string | null;
  imagePrompt?: string;
  voiceText?: string;
}

export interface ContentPatch {
  title?: string;
  caption?: string;
  platform?: Platform;
  status?: ContentStatus;
  scheduledAt?: string | null;
  imagePrompt?: string;
  voiceText?: string;
}

export interface Media {
  mime: string;
  base64: string;
}

export interface ContentStore {
  list(): Promise<ContentItem[]>;
  get(id: string): Promise<ContentItem | null>;
  create(input: ContentInput): Promise<ContentItem>;
  update(id: string, patch: ContentPatch): Promise<ContentItem | null>;
  delete(id: string): Promise<boolean>;
  setMedia(id: string, kind: MediaKind, media: Media): Promise<ContentItem | null>;
  getMedia(id: string, kind: MediaKind): Promise<Media | null>;
}


const isoOrNull = (value: Date | string | null): string | null => (value === null ? null : new Date(value).toISOString());

function publishedAtFor(status: ContentStatus, previous: string | null): string | null {
  if (status !== 'published') return null;
  return previous ?? new Date().toISOString();
}

function definedOnly<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

const COLUMNS = `id, title, caption, platform, status, scheduled_at, published_at, image_prompt, voice_text,
  (image_b64 IS NOT NULL) AS has_image, (audio_b64 IS NOT NULL) AS has_audio, (video_b64 IS NOT NULL) AS has_video, created_at, updated_at`;

interface Row {
  id: string;
  title: string;
  caption: string;
  platform: string;
  status: string;
  scheduled_at: Date | null;
  published_at: Date | null;
  image_prompt: string;
  voice_text: string;
  has_image: boolean;
  has_audio: boolean;
  has_video: boolean;
  created_at: Date;
  updated_at: Date;
}

function fromRow(row: Row): ContentItem {
  return {
    id: row.id,
    title: row.title,
    caption: row.caption,
    platform: row.platform as Platform,
    status: row.status as ContentStatus,
    scheduledAt: isoOrNull(row.scheduled_at),
    publishedAt: isoOrNull(row.published_at),
    imagePrompt: row.image_prompt,
    voiceText: row.voice_text,
    hasImage: row.has_image,
    hasAudio: row.has_audio,
    hasVideo: row.has_video,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export class PgContentStore implements ContentStore {
  constructor(private readonly pool: pg.Pool) {}

  async list(): Promise<ContentItem[]> {
    const { rows } = await this.pool.query<Row>(
      `SELECT ${COLUMNS} FROM content_items ORDER BY (scheduled_at IS NULL), scheduled_at ASC, created_at DESC LIMIT 500`,
    );
    return rows.map(fromRow);
  }
  async get(id: string): Promise<ContentItem | null> {
    const { rows } = await this.pool.query<Row>(`SELECT ${COLUMNS} FROM content_items WHERE id = $1`, [id]);
    return rows[0] === undefined ? null : fromRow(rows[0]);
  }
  async create(input: ContentInput): Promise<ContentItem> {
    const scheduledAt = input.scheduledAt ?? null;
    const { rows } = await this.pool.query<Row>(
      `INSERT INTO content_items (title, caption, platform, status, scheduled_at, image_prompt, voice_text)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${COLUMNS}`,
      [input.title, input.caption ?? '', input.platform ?? 'instagram', scheduledAt === null ? 'draft' : 'scheduled', scheduledAt, input.imagePrompt ?? '', input.voiceText ?? ''],
    );
    return fromRow(rows[0] as Row);
  }
  async update(id: string, patch: ContentPatch): Promise<ContentItem | null> {
    const current = await this.get(id);
    if (current === null) return null;
    const next = { ...current, ...definedOnly(patch) };
    const publishedAt = publishedAtFor(next.status, current.publishedAt);
    const { rows } = await this.pool.query<Row>(
      `UPDATE content_items SET title = $2, caption = $3, platform = $4, status = $5, scheduled_at = $6,
         published_at = $7, image_prompt = $8, voice_text = $9, updated_at = now()
       WHERE id = $1 RETURNING ${COLUMNS}`,
      [id, next.title, next.caption, next.platform, next.status, next.scheduledAt, publishedAt, next.imagePrompt, next.voiceText],
    );
    return rows[0] === undefined ? null : fromRow(rows[0]);
  }
  async delete(id: string): Promise<boolean> {
    const result = await this.pool.query('DELETE FROM content_items WHERE id = $1', [id]);
    return (result.rowCount ?? 0) > 0;
  }
  async setMedia(id: string, kind: MediaKind, media: Media): Promise<ContentItem | null> {
    const column = kind;
    const { rows } = await this.pool.query<Row>(
      `UPDATE content_items SET ${column}_mime = $2, ${column}_b64 = $3, updated_at = now() WHERE id = $1 RETURNING ${COLUMNS}`,
      [id, media.mime, media.base64],
    );
    return rows[0] === undefined ? null : fromRow(rows[0]);
  }
  async getMedia(id: string, kind: MediaKind): Promise<Media | null> {
    const column = kind;
    const { rows } = await this.pool.query<{ mime: string | null; b64: string | null }>(`SELECT ${column}_mime AS mime, ${column}_b64 AS b64 FROM content_items WHERE id = $1`, [id]);
    const row = rows[0];
    return row?.mime && row.b64 ? { mime: row.mime, base64: row.b64 } : null;
  }
}
