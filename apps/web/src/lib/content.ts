/**
 * Client for the content-calendar endpoints. Picture and voice generation run on
 * the server (its Cloudflare key never reaches the browser).
 */

export type Platform = 'instagram' | 'facebook' | 'tiktok' | 'youtube' | 'telegram' | 'other';
export type ContentStatus = 'draft' | 'scheduled' | 'published';
export type VoiceLang = 'es' | 'it' | 'en' | 'fr' | 'de' | 'pt';

export const PLATFORM_LABELS: Record<Platform, string> = {
  instagram: 'Instagram',
  facebook: 'Facebook',
  tiktok: 'TikTok',
  youtube: 'YouTube',
  telegram: 'Telegram',
  other: 'Otra',
};

export const VOICE_LANG_LABELS: Record<VoiceLang, string> = {
  es: 'Español',
  it: 'Italiano',
  en: 'Inglés',
  fr: 'Francés',
  de: 'Alemán',
  pt: 'Portugués',
};

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

export interface NewContent {
  title: string;
  caption?: string;
  platform?: Platform;
  scheduledAt?: string | null;
  imagePrompt?: string;
  voiceText?: string;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
  } catch {
    throw new Error('No se pudo conectar con el servidor.');
  }
  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => null);
    const message = (payload as { error?: { message?: unknown } } | null)?.error?.message;
    throw new Error(typeof message === 'string' ? message : `El servidor respondió con el código ${response.status}.`);
  }
  return (await response.json()) as T;
}

export const listContent = async () => (await call<{ items: ContentItem[] }>('GET', '/api/content')).items;
export interface MediaStatus {
  image: boolean;
  voiceLangs: VoiceLang[];
  video: boolean;
}
export const mediaStatus = async () => (await call<{ media: MediaStatus }>('GET', '/api/content/status')).media;
export const createContent = async (input: NewContent) => (await call<{ item: ContentItem }>('POST', '/api/content', input)).item;
export const updateContent = async (id: string, patch: Partial<NewContent> & { status?: ContentStatus }) =>
  (await call<{ item: ContentItem }>('PATCH', `/api/content/${encodeURIComponent(id)}`, patch)).item;
export const deleteContent = async (id: string) => void (await call('DELETE', `/api/content/${encodeURIComponent(id)}`));
export const generateImage = async (id: string, prompt: string) =>
  (await call<{ item: ContentItem }>('POST', `/api/content/${encodeURIComponent(id)}/image`, { prompt })).item;
export const generateVoice = async (id: string, text: string, lang: VoiceLang) =>
  (await call<{ item: ContentItem }>('POST', `/api/content/${encodeURIComponent(id)}/voice`, { text, lang })).item;
export const startVideo = async (id: string) => void (await call('POST', `/api/content/${encodeURIComponent(id)}/video`));
export const videoStatus = (id: string) => call<{ state: 'idle' | 'running' | 'failed'; message: string | null; item: ContentItem }>('GET', `/api/content/${encodeURIComponent(id)}/video`);

/**
 * Ask for the video and wait for it. The server makes it in the background (a
 * small free server can take a minute or more), so this polls until it is done.
 */
export async function makeVideo(id: string, alive: () => boolean = () => true, pollMs = 3_000, maxMs = 10 * 60_000): Promise<ContentItem> {
  await startVideo(id);
  return waitForVideo(id, alive, pollMs, maxMs);
}

/** Poll a video that is already being made until it is ready, failed or the wait runs out. */
export async function waitForVideo(id: string, alive: () => boolean = () => true, pollMs = 3_000, maxMs = 10 * 60_000): Promise<ContentItem> {
  const deadline = Date.now() + maxMs;
  while (alive() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    const status = await videoStatus(id);
    if (status.state === 'running') continue;
    if (status.state === 'failed') throw new Error(status.message ?? 'No se pudo crear el vídeo.');
    if (status.item.hasVideo) return status.item;
    throw new Error('El vídeo no llegó a crearse (el servidor se reinició). Inténtalo otra vez.');
  }
  throw new Error(alive() ? 'El vídeo tarda demasiado. Vuelve a esta pantalla en unos minutos.' : 'Cancelado.');
}
export const getMedia = (id: string, kind: 'image' | 'audio' | 'video') => call<{ mime: string; base64: string }>('GET', `/api/content/${encodeURIComponent(id)}/media/${kind}`);

/** Which list an item belongs in. A scheduled item whose time has come is "due". */
export type Bucket = 'due' | 'scheduled' | 'draft' | 'published';

export function bucketOf(item: ContentItem, now: number): Bucket {
  if (item.status === 'published') return 'published';
  if (item.status === 'draft' || item.scheduledAt === null) return 'draft';
  return Date.parse(item.scheduledAt) <= now ? 'due' : 'scheduled';
}

export function groupContent(items: readonly ContentItem[], now: number): Record<Bucket, ContentItem[]> {
  const out: Record<Bucket, ContentItem[]> = { due: [], scheduled: [], draft: [], published: [] };
  for (const item of items) out[bucketOf(item, now)].push(item);
  out.published.sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? ''));
  return out;
}

/** `<input type="datetime-local">` value (local time) to an ISO instant; empty means no date. */
export function localInputToIso(value: string): string | null {
  if (value === '') return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

export function isoToLocalInput(iso: string | null): string {
  if (iso === null) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function base64ToBlob(base64: string, mime: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

const EXTENSIONS: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'video/mp4': 'mp4' };

/**
 * Hand a piece to the phone's share sheet (picture + text) so it can go to the
 * chosen app with one more tap. Falls back to copying the text. Nothing is
 * posted on the person's behalf.
 */
export async function shareContent(item: ContentItem, media: { base64: string; mime: string } | null): Promise<'shared' | 'copied' | 'cancelled'> {
  const text = item.caption;
  const files = media === null ? [] : [new File([base64ToBlob(media.base64, media.mime)], `${item.title.slice(0, 40) || 'contenido'}.${EXTENSIONS[media.mime] ?? 'jpg'}`, { type: media.mime })];
  try {
    if (files.length > 0 && navigator.canShare?.({ files }) === true) {
      await navigator.share({ files, text });
      return 'shared';
    }
    if (typeof navigator.share === 'function') {
      await navigator.share({ text });
      return 'shared';
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return 'cancelled';
  }
  await navigator.clipboard.writeText(text);
  return 'copied';
}

/** Ask the crew's report to be turned into draft pieces in the calendar. */
export const draftFromMission = (missionId: string) => call<{ items: ContentItem[] }>('POST', `/api/missions/${encodeURIComponent(missionId)}/content`);

/** "Créame un logo": the server's AI prepares the brief and the real generators make it. */
export const createInStudio = (request: string) => call<{ item: ContentItem; notes: string[]; videoStarted: boolean }>('POST', '/api/content/studio', { request });
