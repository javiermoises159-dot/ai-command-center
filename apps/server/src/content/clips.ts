/**
 * Video editing from a plain-language request: "haz 3 clips de 20 segundos,
 * verticales y con subtítulos".
 *
 * The pieces are deliberately separate so each can be tested and replaced:
 *  - `createEditPlanner` asks a real AI provider for the plan (which parts, how);
 *  - `transcribe` (Cloudflare Whisper, optional) supplies the words and their timing,
 *    both to choose good moments and to burn in captions;
 *  - `createClipMaker` cuts and encodes every clip with ffmpeg on the server.
 * Nothing is uploaded anywhere: the clips come back as files for the calendar.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ProviderRegistry } from '@acc/providers';

import { DraftError } from './draft.ts';
import { MediaError } from './media.ts';
import type { Media } from './store.ts';
import { findFont } from './video.ts';

export interface Segment {
  start: number;
  end: number;
  text: string;
}

export interface PlannedClip {
  start: number;
  end: number;
  title: string;
  caption: string;
}

export interface EditPlan {
  clips: PlannedClip[];
  /** Crop the centre to 9:16 (Reels, TikTok, Shorts). */
  vertical: boolean;
  captions: boolean;
  mute: boolean;
}

export interface EditContext {
  duration: number;
  segments: Segment[];
}

export type EditPlanner = (request: string, context: EditContext) => Promise<EditPlan>;
export type Transcriber = (audio: Media) => Promise<Segment[]>;

export interface ClipResult {
  title: string;
  caption: string;
  video: Media;
}

export interface ClipMakerOutput {
  clips: ClipResult[];
  notes: string[];
}

export type ClipMaker = (input: { video: Media; request: string; onStep: (step: string) => void }) => Promise<ClipMakerOutput>;

export const MAX_CLIPS = 8;
export const MAX_CLIP_SECONDS = 90;
const MIN_CLIP_SECONDS = 2;
const TIMEOUT_MS = 600_000;
const CHUNK_SECONDS = 180;

// ---------------------------------------------------------------- plan

const PLAN_PROMPT = `Eres el editor de vídeo de una pequeña empresa. La persona sube un vídeo y te dice qué edición quiere. Tú decides los cortes.

Responde SOLO con un objeto JSON válido, sin texto extra ni bloques de código:
{"clips":[{"start":0,"end":20,"title":"","caption":""}],"vertical":true,"captions":true,"mute":false}

Reglas:
- "start" y "end" son segundos dentro del vídeo (nunca más allá de su duración). Cada clip dura entre 3 y 90 segundos.
- Si la persona pide un número de clips o una duración, respétalos. Si no, entre 1 y 3 clips de 15 a 45 segundos con lo más interesante.
- Si hay transcripción, empieza y termina los clips en límites de frase y elige los momentos con más gancho. Sin transcripción, reparte los clips de forma razonable.
- "vertical": true si pide formato vertical, Reels, TikTok, Shorts o historias. Si pide dejarlo como está, false.
- "captions": true si pide subtítulos.
- "mute": true solo si pide quitar el sonido.
- "title": nombre corto del clip. "caption": texto para publicarlo, con 3 a 5 hashtags, en el idioma del vídeo.
- Si pide simplemente recortar (por ejemplo "quita los primeros 5 segundos"), devuelve un único clip con ese recorte.
- No inventes datos que no se digan en el vídeo.`;

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Read a plan out of a model answer and keep only clips that fit the video. Returns null when nothing is usable. */
export function parsePlan(answer: string, duration: number): EditPlan | null {
  const start = answer.indexOf('{');
  const end = answer.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(answer.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
  const list = Array.isArray(data['clips']) ? (data['clips'] as unknown[]) : [];
  const clips: PlannedClip[] = [];
  for (const raw of list.slice(0, MAX_CLIPS)) {
    const c = raw as Record<string, unknown> | null;
    const from = num(c?.['start']);
    const to = num(c?.['end']);
    if (from === null || to === null) continue;
    const s = Math.max(0, Math.min(from, duration));
    const e = Math.min(to, duration, s + MAX_CLIP_SECONDS);
    if (e - s < MIN_CLIP_SECONDS) continue;
    const title = typeof c?.['title'] === 'string' ? c['title'].trim().slice(0, 120) : '';
    const caption = typeof c?.['caption'] === 'string' ? c['caption'].trim().slice(0, 4000) : '';
    clips.push({ start: Number(s.toFixed(2)), end: Number(e.toFixed(2)), title: title || `Clip ${clips.length + 1}`, caption });
  }
  if (clips.length === 0) return null;
  return { clips, vertical: data['vertical'] === true, captions: data['captions'] === true, mute: data['mute'] === true };
}

export function transcriptForPlanning(segments: readonly Segment[]): string {
  return segments.map((s) => `[${Math.round(s.start)}-${Math.round(s.end)}] ${s.text}`).join('\n').slice(0, 9_000);
}

export function createEditPlanner(providers: ProviderRegistry): EditPlanner {
  return async (request, context) => {
    const candidates = providers.availableIds().filter((id) => id !== 'mock');
    if (candidates.length === 0) throw new DraftError('No hay ninguna IA real conectada para decidir los cortes.', 409);
    const transcript = context.segments.length > 0 ? `Transcripción con tiempos:\n${transcriptForPlanning(context.segments)}` : 'No hay transcripción disponible.';
    let lastError = 'ninguna IA devolvió cortes utilizables';
    for (const id of candidates) {
      const provider = providers.get(id);
      const model = provider.listModels()[0]?.id;
      if (model === undefined) continue;
      try {
        const result = await provider.execute(
          {
            agentId: 'design',
            systemPrompt: PLAN_PROMPT,
            prompt: `Duración del vídeo: ${context.duration.toFixed(1)} segundos.\n${transcript}\n\nPetición de la persona:\n${request.slice(0, 1500)}\n\nEscribe ahora el JSON.`,
            model,
            temperature: 0.3,
            maxTokens: 1500,
          },
          AbortSignal.timeout(60_000),
        );
        const plan = parsePlan(result.text, context.duration);
        if (plan !== null) return plan;
        lastError = `${provider.label} no devolvió cortes en el formato pedido`;
      } catch (error) {
        lastError = `${provider.label}: ${error instanceof Error ? error.message : 'error'}`;
      }
    }
    throw new DraftError(`No se pudieron decidir los cortes (${lastError}). Vuelve a intentarlo en un momento.`);
  };
}

// ---------------------------------------------------------------- subtitles

const stamp = (t: number): string => {
  const ms = Math.max(0, Math.round(t * 1000));
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(Math.floor(ms / 3_600_000))}:${p(Math.floor(ms / 60_000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
};

/** SRT for one clip: only the segments that overlap it, timed from the clip's own start. */
export function srtFor(segments: readonly Segment[], from: number, to: number): string {
  const lines: string[] = [];
  let n = 0;
  for (const s of segments) {
    if (s.end <= from || s.start >= to || s.text.trim() === '') continue;
    n += 1;
    lines.push(String(n), `${stamp(Math.max(s.start, from) - from)} --> ${stamp(Math.min(s.end, to) - from)}`, s.text.trim().replace(/\s+/g, ' '), '');
  }
  return n === 0 ? '' : lines.join('\n');
}

// ---------------------------------------------------------------- ffmpeg

function run(binary: string, args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout = (stdout + d.toString()).slice(-8_000)));
    child.stderr.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-4_000)));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new MediaError('La edición tardó demasiado. Prueba con un vídeo o un clip más corto.', 504));
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

const lastLines = (text: string): string => text.trim().split('\n').slice(-2).join(' ').slice(0, 200);

export interface ClipMakerOptions {
  plan: EditPlanner;
  /** Optional: without it there are no captions and the AI picks cuts blind. */
  transcribe?: Transcriber | undefined;
  ffmpeg?: string;
  ffprobe?: string;
}

export function createClipMaker(options: ClipMakerOptions): ClipMaker {
  const ffmpeg = options.ffmpeg ?? 'ffmpeg';
  const ffprobe = options.ffprobe ?? 'ffprobe';

  return async ({ video, request, onStep }) => {
    const dir = await mkdtemp(join(tmpdir(), 'acc-clips-'));
    const notes: string[] = [];
    try {
      const source = join(dir, 'source.bin');
      await writeFile(source, Buffer.from(video.base64, 'base64'));

      onStep('Leyendo el vídeo');
      const probe = await run(ffprobe, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', source], 30_000);
      let duration = 0;
      let hasAudio = false;
      try {
        const info = JSON.parse(probe.stdout) as { format?: { duration?: string }; streams?: { codec_type?: string }[] };
        duration = Number.parseFloat(info.format?.duration ?? '');
        hasAudio = info.streams?.some((s) => s.codec_type === 'audio') === true;
      } catch {
        /* handled below */
      }
      if (probe.code !== 0 || !Number.isFinite(duration) || duration <= 0) throw new MediaError('No se pudo leer el vídeo. Prueba con un archivo MP4 o MOV.');

      let segments: Segment[] = [];
      if (options.transcribe !== undefined && hasAudio) {
        onStep('Escuchando lo que se dice');
        try {
          for (let offset = 0; offset < Math.min(duration, 900); offset += CHUNK_SECONDS) {
            const part = join(dir, `audio${offset}.mp3`);
            const cut = await run(ffmpeg, ['-y', '-loglevel', 'error', '-ss', String(offset), '-t', String(CHUNK_SECONDS), '-i', source, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '32k', part], 120_000);
            if (cut.code !== 0) throw new MediaError(`No se pudo extraer el audio: ${lastLines(cut.stderr)}`);
            const found = await options.transcribe({ mime: 'audio/mpeg', base64: (await readFile(part)).toString('base64') });
            segments.push(...found.map((s) => ({ ...s, start: s.start + offset, end: s.end + offset })));
          }
        } catch (error) {
          segments = [];
          notes.push(`No se pudo transcribir el audio (${error instanceof Error ? error.message : 'error'}); los cortes se hicieron sin las palabras.`);
        }
      } else if (options.transcribe === undefined) {
        notes.push('Sin transcripción (falta conectar Cloudflare): los cortes se decidieron sin oír el vídeo y no hay subtítulos.');
      }

      onStep('Decidiendo los cortes');
      const plan = await options.plan(request, { duration, segments });
      const captions = plan.captions && segments.length > 0;
      if (plan.captions && !captions) notes.push('No se pusieron subtítulos porque no hay transcripción.');
      const font = findFont();
      const fontDir = font === null ? null : font.slice(0, font.lastIndexOf('/'));

      const clips: ClipResult[] = [];
      for (const [index, clip] of plan.clips.entries()) {
        onStep(`Creando el clip ${index + 1} de ${plan.clips.length}`);
        const out = join(dir, `clip${index}.mp4`);
        const filters: string[] = [];
        if (plan.vertical) filters.push('crop=min(iw\\,ih*9/16):min(ih\\,iw*16/9)', 'scale=540:960');
        else filters.push("scale='min(720,iw)':-2");
        if (captions) {
          const srt = srtFor(segments, clip.start, clip.end);
          if (srt !== '') {
            const srtPath = join(dir, `clip${index}.srt`);
            await writeFile(srtPath, srt, 'utf8');
            const style = 'FontName=DejaVu Sans,Bold=1,FontSize=14,Alignment=2,MarginV=40,BorderStyle=3,Outline=2,Shadow=0,PrimaryColour=&HFFFFFF&,OutlineColour=&H80000000&';
            filters.push(`subtitles=${srtPath}${fontDir === null ? '' : `:fontsdir=${fontDir}`}:force_style='${style}'`);
          }
        }
        filters.push('format=yuv420p');
        const args = [
          '-y', '-loglevel', 'error', '-ss', String(clip.start), '-t', (clip.end - clip.start).toFixed(2), '-i', source,
          '-vf', filters.join(','),
          '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30', '-threads', '1',
          ...(plan.mute || !hasAudio ? ['-an'] : ['-c:a', 'aac', '-b:a', '96k', '-ar', '44100']),
          '-movflags', '+faststart', out,
        ];
        const result = await run(ffmpeg, args, TIMEOUT_MS);
        if (result.code !== 0) throw new MediaError(`No se pudo crear el clip ${index + 1}: ${lastLines(result.stderr) || `ffmpeg terminó con código ${result.code}`}.`);
        clips.push({ title: clip.title, caption: clip.caption, video: { mime: 'video/mp4', base64: (await readFile(out)).toString('base64') } });
        await rm(out, { force: true });
      }
      return { clips, notes };
    } catch (error) {
      if (error instanceof MediaError || error instanceof DraftError) throw error;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new MediaError('ffmpeg no está instalado en el servidor.', 501);
      throw new MediaError(`No se pudo editar el vídeo: ${error instanceof Error ? error.message : 'error desconocido'}.`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
}
