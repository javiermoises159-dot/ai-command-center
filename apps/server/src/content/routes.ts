/** REST routes for the content calendar. */

import { DomainError } from '@acc/domain';

import { json, type Route } from '../http/types.ts';
import { ALL_VOICE_LANGS, MediaError, type MediaGenerator, type VoiceLang } from './media.ts';
import type { PieceDrafter } from './draft.ts';
import type { ReelMaker } from './video.ts';
import { PLATFORMS, STATUSES, type ContentInput, type ContentPatch, type ContentStore, type MediaKind, type Platform, type ContentStatus } from './store.ts';

export interface ContentDeps {
  store: ContentStore;
  /** Absent when Cloudflare is not configured: the calendar still works, media does not. */
  media: MediaGenerator | undefined;
  /** Builds the vertical video with ffmpeg; undefined when ffmpeg is not installed. */
  video?: ReelMaker | undefined;
  /** Writes content pieces from a mission report. */
  drafter?: PieceDrafter | undefined;
}

const invalid = (message: string) => new DomainError('validation_error', message, { status: 400, publicMessage: message });
const notFound = () => new DomainError('not_found', 'Content item not found.', { status: 404, publicMessage: 'No existe esa pieza de contenido.' });

function text(value: unknown, field: string, max: number, required = false): string | undefined {
  if (value === undefined) {
    if (required) throw invalid(`Falta ${field}.`);
    return undefined;
  }
  if (typeof value !== 'string') throw invalid(`${field} debe ser texto.`);
  const trimmed = value.trim();
  if (required && trimmed === '') throw invalid(`Falta ${field}.`);
  if (trimmed.length > max) throw invalid(`${field} es demasiado largo (máximo ${max} caracteres).`);
  return trimmed;
}

function date(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw invalid('La fecha no es válida.');
  return new Date(value).toISOString();
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) throw invalid(`${field} no es válido.`);
  return value as T;
}

export function parseCreate(body: unknown): ContentInput {
  const b = (body ?? {}) as Record<string, unknown>;
  const input: ContentInput = { title: text(b.title, 'el título', 120, true) as string };
  const caption = text(b.caption, 'el texto', 4000);
  const imagePrompt = text(b.imagePrompt, 'la descripción de la imagen', 1500);
  const voiceText = text(b.voiceText, 'el texto de la voz', 1500);
  const platform = oneOf<Platform>(b.platform, PLATFORMS, 'La plataforma');
  const scheduledAt = date(b.scheduledAt);
  if (caption !== undefined) input.caption = caption;
  if (imagePrompt !== undefined) input.imagePrompt = imagePrompt;
  if (voiceText !== undefined) input.voiceText = voiceText;
  if (platform !== undefined) input.platform = platform;
  if (scheduledAt !== undefined) input.scheduledAt = scheduledAt;
  return input;
}

export function parsePatch(body: unknown): ContentPatch {
  const b = (body ?? {}) as Record<string, unknown>;
  const patch: ContentPatch = {};
  const title = text(b.title, 'el título', 120);
  if (title === '') throw invalid('El título no puede estar vacío.');
  const caption = text(b.caption, 'el texto', 4000);
  const imagePrompt = text(b.imagePrompt, 'la descripción de la imagen', 1500);
  const voiceText = text(b.voiceText, 'el texto de la voz', 1500);
  const platform = oneOf<Platform>(b.platform, PLATFORMS, 'La plataforma');
  const status = oneOf<ContentStatus>(b.status, STATUSES, 'El estado');
  const scheduledAt = date(b.scheduledAt);
  if (title !== undefined) patch.title = title;
  if (caption !== undefined) patch.caption = caption;
  if (imagePrompt !== undefined) patch.imagePrompt = imagePrompt;
  if (voiceText !== undefined) patch.voiceText = voiceText;
  if (platform !== undefined) patch.platform = platform;
  if (status !== undefined) patch.status = status;
  if (scheduledAt !== undefined) {
    patch.scheduledAt = scheduledAt;
    // Giving a date to a draft schedules it; clearing it makes it a draft again.
    if (status === undefined) patch.status = scheduledAt === null ? 'draft' : 'scheduled';
  }
  return patch;
}

function mediaKind(value: string | undefined): MediaKind {
  // The value is also used to pick a database column, so it must stay a closed list.
  if (value === 'image' || value === 'audio' || value === 'video') return value;
  throw invalid('El tipo de archivo debe ser image, audio o video.');
}

export function contentRoutes(deps: ContentDeps): Route[] {
  const missing = (what: string, vars: string) =>
    new DomainError('conflict', `${what} is not configured.`, { status: 409, publicMessage: `Falta ${vars} en el servidor para generar ${what}.` });
  const needImage = (): NonNullable<MediaGenerator['image']> => {
    if (deps.media?.image == null) throw missing('imágenes', 'CLOUDFLARE_ACCOUNT_ID y CLOUDFLARE_API_TOKEN');
    return deps.media.image;
  };
  const needVoice = (): NonNullable<MediaGenerator['voice']> => {
    if (deps.media?.voice == null) throw missing('voz', 'GEMINI_API_KEY (o CLOUDFLARE_ACCOUNT_ID y CLOUDFLARE_API_TOKEN)');
    return deps.media.voice;
  };
  const run = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      if (error instanceof MediaError) throw new DomainError('provider_failed', error.message, { status: error.status, publicMessage: error.message });
      throw error;
    }
  };
  const param = (params: Record<string, string>, name: string) => params[name] ?? '';
  // Videos being made right now (kept in memory: a restart simply loses an unfinished one).
  const videoJobs = new Map<string, { state: 'running' | 'failed'; message: string | null }>();

  return [
    {
      method: 'GET',
      pattern: '/api/content/status',
      handler: async () => json(200, { media: { image: deps.media?.image != null, voiceLangs: deps.media?.voice?.langs ?? [], video: deps.video !== undefined } }),
    },
    { method: 'GET', pattern: '/api/content', handler: async () => json(200, { items: await deps.store.list() }) },
    { method: 'POST', pattern: '/api/content', handler: async (request) => json(201, { item: await deps.store.create(parseCreate(request.body)) }) },
    {
      method: 'PATCH',
      pattern: '/api/content/:id',
      handler: async (request, params) => {
        const item = await deps.store.update(param(params, 'id'), parsePatch(request.body));
        if (item === null) throw notFound();
        return json(200, { item });
      },
    },
    {
      method: 'DELETE',
      pattern: '/api/content/:id',
      handler: async (_request, params) => {
        if (!(await deps.store.delete(param(params, 'id')))) throw notFound();
        return json(200, { ok: true });
      },
    },
    {
      method: 'GET',
      pattern: '/api/content/:id/media/:kind',
      handler: async (_request, params) => {
        const media = await deps.store.getMedia(param(params, 'id'), mediaKind(params.kind));
        if (media === null) throw new DomainError('not_found', 'No media.', { status: 404, publicMessage: 'Esta pieza todavía no tiene ese archivo.' });
        return json(200, media);
      },
    },
    {
      method: 'POST',
      pattern: '/api/content/:id/image',
      handler: async (request, params) => {
        const generate = needImage();
        const id = param(params, 'id');
        const item = await deps.store.get(id);
        if (item === null) throw notFound();
        const prompt = text((request.body as { prompt?: unknown } | undefined)?.prompt, 'la descripción de la imagen', 1500) ?? item.imagePrompt;
        if (prompt === '') throw invalid('Escribe primero qué imagen quieres.');
        const media = await run(() => generate(prompt));
        await deps.store.update(id, { imagePrompt: prompt });
        return json(200, { item: await deps.store.setMedia(id, 'image', media) });
      },
    },
    {
      method: 'POST',
      pattern: '/api/content/:id/voice',
      handler: async (request, params) => {
        const voice = needVoice();
        const id = param(params, 'id');
        const item = await deps.store.get(id);
        if (item === null) throw notFound();
        const body = (request.body ?? {}) as { text?: unknown; lang?: unknown };
        const voiceText = text(body.text, 'el texto de la voz', 1500) ?? item.voiceText;
        if (voiceText === '') throw invalid('Escribe primero qué debe decir la voz.');
        const lang: VoiceLang = oneOf<VoiceLang>(body.lang, ALL_VOICE_LANGS, 'El idioma') ?? 'es';
        if (!voice.langs.includes(lang)) throw invalid('Ese idioma no está disponible con la voz configurada.');
        const media = await run(() => voice.speak(voiceText, lang));
        await deps.store.update(id, { voiceText });
        return json(200, { item: await deps.store.setMedia(id, 'audio', media) });
      },
    },
    {
      // Starts the video in the background and answers at once: on a small free server
      // it can take a minute or more, far longer than a request should wait.
      method: 'POST',
      pattern: '/api/content/:id/video',
      handler: async (_request, params) => {
        const makeReel = deps.video;
        if (makeReel === undefined) {
          throw new DomainError('conflict', 'Video is not available.', { status: 409, publicMessage: 'El servidor no tiene ffmpeg instalado, así que todavía no puede crear vídeos.' });
        }
        const id = param(params, 'id');
        const item = await deps.store.get(id);
        if (item === null) throw notFound();
        if (videoJobs.get(id)?.state === 'running') return json(202, { job: videoJobs.get(id) });
        const [image, audio] = await Promise.all([deps.store.getMedia(id, 'image'), deps.store.getMedia(id, 'audio')]);
        if (image === null || audio === null) throw invalid('Para crear el vídeo primero genera la imagen y la voz.');
        videoJobs.set(id, { state: 'running', message: null });
        void makeReel({ image, audio, text: item.voiceText })
          .then(async (video) => {
            await deps.store.setMedia(id, 'video', video);
            videoJobs.delete(id);
          })
          .catch((error: unknown) => {
            videoJobs.set(id, { state: 'failed', message: error instanceof Error ? error.message : 'No se pudo crear el vídeo.' });
          });
        return json(202, { job: videoJobs.get(id) });
      },
    },
    {
      // "running" while it works, "failed" (with the reason) once, then "idle".
      method: 'GET',
      pattern: '/api/content/:id/video',
      handler: async (_request, params) => {
        const id = param(params, 'id');
        const item = await deps.store.get(id);
        if (item === null) throw notFound();
        const job = videoJobs.get(id);
        if (job?.state === 'failed') videoJobs.delete(id);
        return json(200, { state: job?.state ?? 'idle', message: job?.message ?? null, item });
      },
    },
  ];
}
