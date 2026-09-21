/**
 * Vertical video (9:16, 720x1280) from a picture, a voice-over and its text.
 *
 * Runs ffmpeg on the server: the picture fills the frame (blurred copy behind, the
 * sharp one centred), the voice is the soundtrack, and the text is burned in as
 * captions timed to the voice. Nothing leaves the server and nothing is paid for.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MediaError } from './media.ts';
import type { Media } from './store.ts';

export const WIDTH = 720;
export const HEIGHT = 1280;
/** Instagram Reels and TikTok accept far longer; a minute keeps a free server comfortable. */
export const MAX_SECONDS = 60;
const LINE_CHARS = 22;
const MAX_LINES = 4;
const TIMEOUT_MS = 150_000;

export interface Caption {
  start: number;
  end: number;
  text: string;
}

/** Greedy word wrap. A single very long word is kept whole rather than cut. */
export function wrap(text: string, width = LINE_CHARS): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line === '') line = word;
    else if (line.length + 1 + word.length <= width) line += ` ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line !== '') lines.push(line);
  return lines;
}

/**
 * Split the voice text into caption blocks (sentences, then lines that fit the
 * screen) and time each one in proportion to its length across the audio.
 */
export function captionsFor(text: string, seconds: number): Caption[] {
  const sentences = text.replace(/\s+/g, ' ').trim().match(/[^.!?…]+[.!?…]*/g) ?? [];
  const blocks: string[] = [];
  for (const sentence of sentences.map((s) => s.trim()).filter(Boolean)) {
    const lines = wrap(sentence);
    for (let i = 0; i < lines.length; i += MAX_LINES) blocks.push(lines.slice(i, i + MAX_LINES).join('\n'));
  }
  const total = blocks.reduce((sum, b) => sum + b.replace(/\n/g, ' ').length, 0);
  if (total === 0 || seconds <= 0) return [];
  let cursor = 0;
  return blocks.map((block, index) => {
    const share = (block.replace(/\n/g, ' ').length / total) * seconds;
    const start = cursor;
    cursor = index === blocks.length - 1 ? seconds : cursor + share;
    return { start: Number(start.toFixed(3)), end: Number(cursor.toFixed(3)), text: block };
  });
}

const FONT_CANDIDATES = [
  process.env['VIDEO_FONT_FILE'],
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
];

export function findFont(): string | null {
  return FONT_CANDIDATES.find((f): f is string => typeof f === 'string' && f !== '' && existsSync(f)) ?? null;
}

export function ffmpegAvailable(binary = 'ffmpeg'): boolean {
  try {
    return spawnSync(binary, ['-version'], { timeout: 5_000 }).status === 0;
  } catch {
    return false;
  }
}

function run(binary: string, args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout = (stdout + d.toString()).slice(-4_000)));
    child.stderr.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-4_000)));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new MediaError('El vídeo tardó demasiado en crearse. Prueba con un texto más corto.', 504));
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'audio/wav': 'wav', 'audio/mpeg': 'mp3' };

export interface ReelInput {
  image: Media;
  audio: Media;
  /** The words spoken; shown as captions. */
  text: string;
}

export type ReelMaker = (input: ReelInput) => Promise<Media>;

export function createReelMaker(options: { ffmpeg?: string; ffprobe?: string } = {}): ReelMaker {
  const ffmpeg = options.ffmpeg ?? 'ffmpeg';
  const ffprobe = options.ffprobe ?? 'ffprobe';

  return async ({ image, audio, text }) => {
    const dir = await mkdtemp(join(tmpdir(), 'acc-reel-'));
    try {
      const imagePath = join(dir, `image.${EXT[image.mime] ?? 'jpg'}`);
      const audioPath = join(dir, `voice.${EXT[audio.mime] ?? 'wav'}`);
      const outPath = join(dir, 'reel.mp4');
      await writeFile(imagePath, Buffer.from(image.base64, 'base64'));
      await writeFile(audioPath, Buffer.from(audio.base64, 'base64'));

      const probe = await run(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', audioPath], 20_000);
      const seconds = Number.parseFloat(probe.stdout.trim());
      if (probe.code !== 0 || !Number.isFinite(seconds) || seconds <= 0) throw new MediaError('No se pudo leer la duración de la voz. Genera la voz otra vez.');
      const duration = Math.min(seconds, MAX_SECONDS);

      // Each caption block goes in its own file: no quoting or escaping to get wrong.
      const font = findFont();
      const captions = font === null ? [] : captionsFor(text, duration);
      const drawtexts: string[] = [];
      for (const [index, caption] of captions.entries()) {
        const file = join(dir, `cap${index}.txt`);
        await writeFile(file, caption.text, 'utf8');
        drawtexts.push(
          `drawtext=fontfile=${font}:textfile=${file}:fontsize=42:fontcolor=white:line_spacing=10:box=1:boxcolor=black@0.55:boxborderw=18:x=(w-text_w)/2:y=h*0.70:enable='between(t,${caption.start},${caption.end})'`,
        );
      }

      const graph = [
        `[0:v]scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase,crop=${WIDTH}:${HEIGHT},boxblur=24:3[bg]`,
        `[0:v]scale=${WIDTH}:-2[fg]`,
        `[bg][fg]overlay=(W-w)/2:(H-h)/2${drawtexts.length > 0 ? `,${drawtexts.join(',')}` : ''},format=yuv420p[v]`,
      ].join(';');

      const result = await run(
        ffmpeg,
        [
          '-y', '-loglevel', 'error',
          '-loop', '1', '-framerate', '24', '-i', imagePath,
          '-i', audioPath,
          '-filter_complex', graph,
          '-map', '[v]', '-map', '1:a',
          '-t', duration.toFixed(2),
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '27', '-threads', '2',
          '-c:a', 'aac', '-b:a', '128k', '-ar', '44100',
          '-movflags', '+faststart',
          outPath,
        ],
        TIMEOUT_MS,
      );
      if (result.code !== 0) {
        throw new MediaError(`No se pudo crear el vídeo: ${result.stderr.trim().split('\n').slice(-2).join(' ').slice(0, 200) || `ffmpeg terminó con código ${result.code}`}.`);
      }
      return { mime: 'video/mp4', base64: (await readFile(outPath)).toString('base64') };
    } catch (error) {
      if (error instanceof MediaError) throw error;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new MediaError('ffmpeg no está instalado en el servidor.', 501);
      throw new MediaError(`No se pudo crear el vídeo: ${error instanceof Error ? error.message : 'error desconocido'}.`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
}
