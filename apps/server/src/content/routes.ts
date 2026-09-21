/** REST routes for the content calendar. */

import { DomainError } from '@acc/domain';

import { json, type Route } from '../http/types.ts';
import { ALL_VOICE_LANGS, MediaError, type MediaGenerator, type VoiceLang } from './media.ts';
import type { PieceDrafter } from './draft.ts';
import type { StudioBriefer } from './studio.ts';
import type { ClipMaker } from './clips.ts';
import { runAssistant, spreadDates, type AssistantPlanner, type AssistantTools } from './assistant.ts';
import type { Publisher } from './publish.ts';
import type { ReelMaker } from './video.ts';
import { PLATFORMS, STATUSES, type Media, type ContentInput, type ContentPatch, type ContentStore, type MediaKind, type Platform, type ContentStatus } from './store.ts';

export interface ContentDeps {
  /** Test hook: pause between image retries. */
  imagePause?: (ms: number) => Promise<void>;
  store: ContentStore;
  /** Absent when Cloudflare is not configured: the calendar still works, media does not. */
  media: MediaGenerator | undefined;
  /** Builds the vertical video with ffmpeg; undefined when ffmpeg is not installed. */
  video?: ReelMaker | undefined;
  /** Writes content pieces from a mission report. */
  drafter?: PieceDrafter | undefined;
  /** Turns a free-text request into what the studio should generate. */
  studio?: StudioBriefer | undefined;
  /** Cuts and edits an uploaded video from a plain-language request; undefined without ffmpeg. */
  clips?: ClipMaker | undefined;
  /** Turns "prepárame una campaña" into actions on the tools above. */
  assistant?: AssistantPlanner | undefined;
  /** Where a finished piece can really be published (only on the person's tap). */
  publishers?: readonly Publisher[] | undefined;
}

/** Largest video accepted, in bytes: a small free server has to hold it in memory. */
export const MAX_UPLOAD_BYTES = 30 * 1024 * 1024;

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

  // Edits running or finished since the server started (an unfinished one is lost on restart).
  interface EditJob { state: 'running' | 'done' | 'failed'; step: string; message: string | null; notes: string[]; itemIds: string[] }
  const editJobs = new Map<string, EditJob>();
  const startVideoJob = async (id: string, voiceText: string): Promise<void> => {
    const makeReel = deps.video;
    if (makeReel === undefined) return;
    const [image, audio] = await Promise.all([deps.store.getMedia(id, 'image'), deps.store.getMedia(id, 'audio')]);
    if (image === null || audio === null) throw invalid('Para crear el vídeo primero genera la imagen y la voz.');
    videoJobs.set(id, { state: 'running', message: null });
    void makeReel({ image, audio, text: voiceText })
      .then(async (video) => {
        await deps.store.setMedia(id, 'video', video);
        videoJobs.delete(id);
      })
      .catch((error: unknown) => {
        videoJobs.set(id, { state: 'failed', message: error instanceof Error ? error.message : 'No se pudo crear el vídeo.' });
      });
  };


  const startEditJob = (id: string, ask: string, video: Media): EditJob => {
    const makeClips = deps.clips!;
      const job: EditJob = { state: 'running', step: 'Empezando', message: null, notes: [], itemIds: [] };
      editJobs.set(id, job);
      void makeClips({ video, request: ask, onStep: (step) => { job.step = step; } })
        .then(async (made) => {
          for (const clip of made.clips) {
            const created = await deps.store.create({ title: clip.title, platform: 'instagram', caption: clip.caption });
            await deps.store.setMedia(created.id, 'video', clip.video);
            job.itemIds.push(created.id);
          }
          job.notes = made.notes;
          job.state = 'done';
          job.step = 'Listo';
        })
        .catch((error: unknown) => {
          job.state = 'failed';
          job.message = error instanceof Error ? error.message : 'No se pudo editar el vídeo.';
        });
    return job;
  };

  const studioCreate = async (ask: string) => {
    if (deps.studio === undefined) throw new DomainError('conflict', 'Studio unavailable.', { status: 409, publicMessage: 'No hay ninguna IA real conectada para preparar la creación.' });
      let brief;
      try {
        brief = await deps.studio(ask);
      } catch (error) {
        if (error instanceof Error && error.name === 'DraftError') {
          const status = (error as { status?: number }).status ?? 502;
          throw new DomainError('provider_failed', error.message, { status, publicMessage: error.message });
        }
        throw error;
      }
      let item = await deps.store.create({ title: brief.title, platform: brief.platform, caption: brief.caption, voiceText: brief.voiceText, imagePrompt: brief.imagePrompt });
      const notes: string[] = [];
      let videoStarted = false;
      if (brief.wants.includes('image')) {
        if (deps.media?.image == null) notes.push('La imagen no se pudo crear: falta conectar Cloudflare.');
        else {
          try {
            item = (await deps.store.setMedia(item.id, 'image', await deps.media.image(brief.imagePrompt))) ?? item;
          } catch (error) {
            notes.push(`La imagen no se pudo crear: ${error instanceof Error ? error.message : 'error'}`);
          }
        }
      }
      if (brief.wants.includes('voice')) {
        const voice = deps.media?.voice;
        if (voice == null) notes.push('La voz no se pudo crear: falta conectar Gemini.');
        else {
          const lang = voice.langs.includes(brief.lang) ? brief.lang : voice.langs[0];
          try {
            if (lang === undefined) throw new MediaError('No hay idiomas de voz disponibles.');
            item = (await deps.store.setMedia(item.id, 'audio', await voice.speak(brief.voiceText, lang))) ?? item;
          } catch (error) {
            notes.push(`La voz no se pudo crear: ${error instanceof Error ? error.message : 'error'}`);
          }
        }
      }
      if (brief.wants.includes('video')) {
        if (deps.video === undefined) notes.push('El vídeo no se pudo crear: el servidor no tiene ffmpeg.');
        else if (item.hasImage && item.hasAudio) {
          await startVideoJob(item.id, brief.voiceText);
          videoStarted = true;
        } else notes.push('El vídeo no se pudo crear porque falló la imagen o la voz.');
      }
    return { item, notes, videoStarted };
  };

  // ---- assistant: one request, several actions, run in the background ----
  interface AssistantJob { state: 'running' | 'done' | 'failed'; step: string; reply: string; notes: string[]; itemIds: string[]; message: string | null }
  const assistantJobs = new Map<string, AssistantJob>();
  const assistantTools: AssistantTools = {
    create: async (ask) => {
      const made = await studioCreate(ask);
      return { itemIds: [made.item.id], notes: made.notes };
    },
    campaign: async (topic, pieces, days) => {
      if (deps.drafter === undefined) throw new Error('No hay ninguna IA real conectada para escribir la campaña.');
      const written = (await deps.drafter(topic)).slice(0, pieces);
      const dates = spreadDates(written.length, days);
      const itemIds: string[] = [];
      const notes: string[] = [];
      const pending: { id: string; title: string; prompt: string; reason: string }[] = [];
      const wait = deps.imagePause ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
      for (const [index, piece] of written.entries()) {
        const created = await deps.store.create({ ...piece, scheduledAt: dates[index] ?? null });
        itemIds.push(created.id);
        if (piece.imagePrompt !== undefined && piece.imagePrompt !== '' && deps.media?.image != null) {
          try {
            await deps.store.setMedia(created.id, 'image', await deps.media.image(piece.imagePrompt));
          } catch (error) {
            pending.push({ id: created.id, title: piece.title, prompt: piece.imagePrompt, reason: error instanceof Error ? error.message : 'error' });
          }
        }
      }
      // Free image services throttle bursts: give them a breather and try the missing ones once more.
      if (pending.length > 0 && deps.media?.image != null) {
        await wait(25_000);
        for (const item of pending) {
          try {
            await deps.store.setMedia(item.id, 'image', await deps.media.image(item.prompt));
          } catch (error) {
            notes.push(`«${item.title}»: sin imagen (${error instanceof Error ? error.message : item.reason}). Puedes crearla luego con «Imagen» en Contenidos.`);
          }
          await wait(3_000);
        }
      }
      return { itemIds, notes };
    },
    editLatestVideo: async (ask) => {
      if (deps.clips === undefined) throw new Error('El servidor no tiene ffmpeg, así que no puede editar vídeos.');
      const uploaded = (await deps.store.list()).filter((i) => i.hasVideo && i.title.startsWith('Vídeo original'));
      const latest = uploaded.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))[0];
      const video = latest === undefined ? null : await deps.store.getMedia(latest.id, 'video');
      if (latest === undefined || video === null) throw new Error('No hay ningún vídeo subido. Súbelo primero en Creatividad → Tus vídeos.');
      startEditJob(latest.id, ask, video);
      return { notes: [`Estoy cortando «${latest.title.replace('Vídeo original: ', '')}». Los clips aparecerán en Contenidos en unos minutos.`] };
    },
  };

  return [
    {
      method: 'GET',
      pattern: '/api/content/status',
      handler: async () => json(200, { media: { image: deps.media?.image != null, voiceLangs: deps.media?.voice?.langs ?? [], video: deps.video !== undefined, edit: deps.clips !== undefined, assistant: deps.assistant !== undefined }, publishers: (deps.publishers ?? []).map((p) => ({ target: p.target, label: p.label })) }),
    },
    {
      // "Créame un logo": the AI writes the brief, then the real generators make the
      // picture / voice, and a video starts in the background when one was asked for.
      method: 'POST',
      pattern: '/api/content/studio',
      handler: async (request) => {
        if (deps.studio === undefined) throw new DomainError('conflict', 'Studio unavailable.', { status: 409, publicMessage: 'No hay ninguna IA real conectada para preparar la creación.' });
        const ask = text((request.body as { request?: unknown } | undefined)?.request, 'lo que quieres crear', 2000, true) ?? '';
        return json(201, await studioCreate(ask));
      },
    },
    {
      // A video the person recorded, to be edited or clipped. Kept as a draft item.
      method: 'POST',
      pattern: '/api/content/upload',
      handler: async (request) => {
        const body = (request.body ?? {}) as { title?: unknown; mime?: unknown; base64?: unknown };
        const base64 = typeof body.base64 === 'string' ? body.base64 : '';
        if (base64 === '') throw invalid('Falta el vídeo.');
        const mime = typeof body.mime === 'string' && body.mime.startsWith('video/') ? body.mime : 'video/mp4';
        if (Math.floor((base64.length * 3) / 4) > MAX_UPLOAD_BYTES) throw invalid(`El vídeo pesa demasiado (máximo ${MAX_UPLOAD_BYTES / 1024 / 1024} MB). Recórtalo un poco antes de subirlo.`);
        const title = text(body.title, 'el título', 120) || 'Vídeo subido';
        const item = await deps.store.create({ title: `Vídeo original: ${title}`, platform: 'other' });
        return json(201, { item: (await deps.store.setMedia(item.id, 'video', { mime, base64 })) ?? item });
      },
    },
    {
      method: 'POST',
      pattern: '/api/content/:id/edit',
      handler: async (request, params) => {
        const makeClips = deps.clips;
        if (makeClips === undefined) throw new DomainError('conflict', 'Editing unavailable.', { status: 409, publicMessage: 'El servidor no tiene ffmpeg instalado, así que todavía no puede editar vídeos.' });
        const id = param(params, 'id');
        const source = await deps.store.get(id);
        if (source === null) throw notFound();
        const ask = text((request.body as { request?: unknown } | undefined)?.request, 'la edición que quieres', 1500, true) ?? '';
        if (editJobs.get(id)?.state === 'running') return json(202, { job: editJobs.get(id) });
        const video = await deps.store.getMedia(id, 'video');
        if (video === null) throw invalid('Esta pieza no tiene ningún vídeo que editar.');
        const job = startEditJob(id, ask, video);
        return json(202, { job });
      },
    },
    {
      method: 'GET',
      pattern: '/api/content/:id/edit',
      handler: async (_request, params) => {
        const id = param(params, 'id');
        const job = editJobs.get(id);
        if (job === undefined) return json(200, { state: 'idle', step: '', message: null, notes: [], items: [] });
        const items = (await Promise.all(job.itemIds.map((itemId) => deps.store.get(itemId)))).filter((i) => i !== null);
        return json(200, { state: job.state, step: job.step, message: job.message, notes: job.notes, items });
      },
    },
    {
      method: 'POST',
      pattern: '/api/assistant',
      handler: async (request) => {
        const plan = deps.assistant;
        if (plan === undefined) throw new DomainError('conflict', 'Assistant unavailable.', { status: 409, publicMessage: 'No hay ninguna IA real conectada para entender la petición.' });
        const ask = text((request.body as { request?: unknown } | undefined)?.request, 'lo que quieres que haga', 2000, true) ?? '';
        const id = crypto.randomUUID();
        const job: AssistantJob = { state: 'running', step: 'Entendiendo tu petición', reply: '', notes: [], itemIds: [], message: null };
        assistantJobs.set(id, job);
        for (const old of [...assistantJobs.keys()].slice(0, Math.max(0, assistantJobs.size - 20))) assistantJobs.delete(old);
        void (async () => {
          const uploaded = (await deps.store.list()).some((i) => i.hasVideo && i.title.startsWith('Vídeo original'));
          const made = await plan(ask, { hasUploadedVideo: uploaded });
          job.reply = made.reply;
          const outcome = await runAssistant(made, assistantTools, (step) => { job.step = step; });
          job.itemIds = outcome.itemIds;
          job.notes = outcome.notes;
          job.state = 'done';
          job.step = 'Listo';
        })().catch((error: unknown) => {
          job.state = 'failed';
          job.message = error instanceof Error ? error.message : 'No se pudo completar la petición.';
        });
        return json(202, { id });
      },
    },
    {
      method: 'GET',
      pattern: '/api/assistant/:jobId',
      handler: async (_request, params) => {
        const job = assistantJobs.get(param(params, 'jobId'));
        if (job === undefined) throw new DomainError('not_found', 'No such job.', { status: 404, publicMessage: 'Esa petición ya no existe (el servidor se reinició). Vuelve a pedirla.' });
        const items = (await Promise.all(job.itemIds.map((itemId) => deps.store.get(itemId)))).filter((i) => i !== null);
        return json(200, { state: job.state, step: job.step, reply: job.reply, notes: job.notes, message: job.message, items });
      },
    },
    {
      // The tap on this button is the approval: nothing publishes on its own.
      method: 'POST',
      pattern: '/api/content/:id/publish',
      handler: async (request, params) => {
        const target = (request.body as { target?: unknown } | undefined)?.target;
        const publisher = (deps.publishers ?? []).find((p) => p.target === target);
        if (publisher === undefined) throw invalid('Esa red no está conectada en el servidor.');
        const id = param(params, 'id');
        const item = await deps.store.get(id);
        if (item === null) throw notFound();
        const [image, audio, video] = await Promise.all([deps.store.getMedia(id, 'image'), deps.store.getMedia(id, 'audio'), deps.store.getMedia(id, 'video')]);
        const caption = item.caption.trim() !== '' ? item.caption : item.title;
        const result = await run(() => publisher.publish({ caption, image, audio, video }));
        const updated = await deps.store.update(id, { status: 'published' });
        return json(200, { result, item: updated ?? item });
      },
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
        await startVideoJob(id, item.voiceText);
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
