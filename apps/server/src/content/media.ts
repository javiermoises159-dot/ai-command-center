/**
 * Picture and voice generation, both on free tiers.
 *
 *  - Pictures: Cloudflare Workers AI (FLUX schnell), after translating the description to English.
 *  - Voice: Gemini text-to-speech (Spanish, Italian, English, French, German,
 *    Portuguese) when a Gemini key is present; otherwise Cloudflare MeloTTS, which
 *    on Workers AI only accepts English and French.
 *
 * Keys stay on the server. Nothing is invented on failure: an error is returned
 * in words a person can act on.
 */

import type { Media } from './store.ts';

export const IMAGE_MODEL = '@cf/black-forest-labs/flux-1-schnell';
export const TRANSLATE_MODEL = '@cf/meta/llama-3.1-8b-instruct';
export const CLOUDFLARE_VOICE_MODEL = '@cf/myshell-ai/melotts';
export const DEFAULT_GEMINI_TTS_MODEL = 'gemini-2.5-flash-preview-tts';

export const ALL_VOICE_LANGS = ['es', 'it', 'en', 'fr', 'de', 'pt'] as const;
export type VoiceLang = (typeof ALL_VOICE_LANGS)[number];
/** What Cloudflare's MeloTTS accepts. `es` is rejected by the service ("Invalid input"). */
export const CLOUDFLARE_VOICE_LANGS: readonly VoiceLang[] = ['en', 'fr'];

export class MediaError extends Error {
  constructor(message: string, readonly status = 502) {
    super(message);
    this.name = 'MediaError';
  }
}

export interface MediaGenerator {
  /** Null when no picture service is configured. */
  image: ((prompt: string) => Promise<Media>) | null;
  /** Null when no voice service is configured. */
  voice: { langs: readonly VoiceLang[]; speak(text: string, lang: VoiceLang): Promise<Media> } | null;
}

export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export class CloudflareMedia {
  constructor(
    private readonly accountId: string,
    private readonly token: string,
    private readonly fetchImpl: Fetch = fetch as unknown as Fetch,
  ) {}

  async image(prompt: string): Promise<Media> {
    // The picture model understands English far better than Spanish or Italian, and
    // the person should not need English: translate first. If that step fails the
    // original text is used, so a translation hiccup never blocks a picture.
    const english = await this.toEnglish(prompt);
    const data = await this.run(IMAGE_MODEL, { prompt: english.slice(0, 2000), steps: 6 });
    const image = pick(data, 'image');
    if (image === null) throw new MediaError('Cloudflare no devolvió ninguna imagen. Prueba con otra descripción.');
    return { mime: image.startsWith('/9j/') ? 'image/jpeg' : 'image/png', base64: image };
  }

  /** A description in any language, as an English prompt for the picture model. Never throws. */
  async toEnglish(prompt: string): Promise<string> {
    try {
      const data = await this.run(TRANSLATE_MODEL, {
        max_tokens: 200,
        messages: [
          {
            role: 'system',
            content:
              'You write prompts for an image generator. Translate the user text into natural English, keeping every detail, and add nothing else. Reply with the English prompt only, on one line, without quotes or comments.',
          },
          { role: 'user', content: prompt.slice(0, 1000) },
        ],
      });
      const said = pick(data, 'response')?.trim().replace(/^["'“]+|["'”]+$/g, '');
      return said !== undefined && said !== '' && said.length < 1500 ? said : prompt;
    } catch {
      return prompt;
    }
  }

  /** Speech to text with timing. Whisper large-v3-turbo: audio goes in as base64, segments come back. */
  async transcribe(audio: Media): Promise<{ start: number; end: number; text: string }[]> {
    const data = await this.run('@cf/openai/whisper-large-v3-turbo', { audio: audio.base64 });
    const result = (data as { result?: { segments?: unknown; text?: unknown } } | null)?.result;
    const segments = Array.isArray(result?.segments) ? (result?.segments as Record<string, unknown>[]) : [];
    const out = segments
      .map((s) => ({ start: Number(s['start']), end: Number(s['end']), text: typeof s['text'] === 'string' ? s['text'].trim() : '' }))
      .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start && s.text !== '');
    if (out.length === 0 && typeof result?.text === 'string' && result.text.trim() !== '') throw new MediaError('Cloudflare devolvió el texto sin tiempos.');
    return out;
  }

  async voice(text: string, lang: VoiceLang): Promise<Media> {
    if (!CLOUDFLARE_VOICE_LANGS.includes(lang)) {
      throw new MediaError('La voz de Cloudflare solo habla inglés y francés. Para español o italiano hace falta la clave de Gemini (GEMINI_API_KEY).', 400);
    }
    const data = await this.run(CLOUDFLARE_VOICE_MODEL, { prompt: text.slice(0, 1500), lang });
    const audio = pick(data, 'audio');
    if (audio === null) throw new MediaError('Cloudflare no devolvió ningún audio.');
    return { mime: 'audio/mpeg', base64: audio };
  }

  private async run(model: string, input: Record<string, unknown>): Promise<unknown> {
    let response;
    try {
      response = await this.fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(this.accountId)}/ai/run/${model}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (error) {
      throw new MediaError(`No se pudo conectar con Cloudflare: ${error instanceof Error ? error.message : 'error de red'}.`);
    }
    const raw = await response.text();
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new MediaError('Cloudflare rechazó el token. Revisa CLOUDFLARE_API_TOKEN (permiso Workers AI) y CLOUDFLARE_ACCOUNT_ID.', 502);
      }
      if (response.status === 429) throw new MediaError('Se agotó el cupo gratuito de Cloudflare por hoy. Vuelve a intentarlo mañana.', 429);
      throw new MediaError(`Cloudflare respondió con error ${response.status}: ${readError(raw)}`);
    }
    try {
      return JSON.parse(raw);
    } catch {
      throw new MediaError('Cloudflare devolvió una respuesta que no se entiende.');
    }
  }
}

/** Gemini text-to-speech. The model detects the language of the text itself. */
export class GeminiVoice {
  readonly langs: readonly VoiceLang[] = ALL_VOICE_LANGS;

  constructor(
    private readonly apiKey: string,
    private readonly model: string = DEFAULT_GEMINI_TTS_MODEL,
    private readonly fetchImpl: Fetch = fetch as unknown as Fetch,
  ) {}

  async speak(text: string, _lang: VoiceLang): Promise<Media> {
    let response;
    try {
      response = await this.fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent`, {
        method: 'POST',
        // The key travels in a header, never in the URL, so it cannot end up in logs.
        headers: { 'x-goog-api-key': this.apiKey, 'content-type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: text.slice(0, 1500) }] }],
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } },
          },
        }),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (error) {
      throw new MediaError(`No se pudo conectar con Gemini: ${error instanceof Error ? error.message : 'error de red'}.`);
    }
    const raw = await response.text();
    if (!response.ok) {
      if (response.status === 400 || response.status === 401 || response.status === 403) {
        throw new MediaError(`Gemini rechazó la petición de voz (${response.status}): ${readGoogleError(raw)}. Revisa GEMINI_API_KEY y GEMINI_TTS_MODEL.`);
      }
      if (response.status === 404) throw new MediaError(`Gemini no tiene el modelo de voz «${this.model}». Cambia GEMINI_TTS_MODEL por uno vigente.`);
      if (response.status === 429) throw new MediaError('Se agotó el cupo gratuito de voz de Gemini. Vuelve a intentarlo dentro de un rato.', 429);
      throw new MediaError(`Gemini respondió con error ${response.status}: ${readGoogleError(raw)}`);
    }
    let pcm: string | null = null;
    try {
      const data = JSON.parse(raw) as { candidates?: { content?: { parts?: { inlineData?: { data?: string } }[] } }[] };
      pcm = data.candidates?.[0]?.content?.parts?.find((p) => typeof p.inlineData?.data === 'string')?.inlineData?.data ?? null;
    } catch {
      /* handled below */
    }
    if (pcm === null) throw new MediaError('Gemini no devolvió ningún audio. Prueba con otro texto.');
    return { mime: 'audio/wav', base64: pcmToWavBase64(pcm) };
  }
}

/** Gemini returns raw 16-bit mono PCM at 24 kHz; browsers need a container. */
export function pcmToWavBase64(pcmBase64: string, sampleRate = 24_000): string {
  const pcm = Buffer.from(pcmBase64, 'base64');
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]).toString('base64');
}

/** One way of making a picture. A chain of them keeps working when a free quota runs out. */
export interface ImageStep {
  name: string;
  run(prompt: string): Promise<Media>;
}

const MIN_30 = 30 * 60_000;

/**
 * Try each picture service in turn. A service that says its quota is spent (429) is
 * skipped for a while instead of being asked again on every request. When all fail the
 * error names each one, so the person knows what happened and what to add.
 */
export function chainImages(steps: readonly ImageStep[], options: { cooldownMs?: number; now?: () => number } = {}): (prompt: string) => Promise<Media> {
  const cooldown = options.cooldownMs ?? MIN_30;
  const now = options.now ?? Date.now;
  const resting = new Map<string, number>();
  return async (prompt) => {
    const problems: string[] = [];
    let quotaOnly = true;
    for (const step of steps) {
      const until = resting.get(step.name) ?? 0;
      if (until > now()) {
        problems.push(`${step.name}: sin cupo por ahora`);
        continue;
      }
      try {
        return await step.run(prompt);
      } catch (error) {
        const status = error instanceof MediaError ? error.status : 502;
        if (status === 429) resting.set(step.name, now() + cooldown);
        else quotaOnly = false;
        problems.push(`${step.name}: ${error instanceof Error ? error.message : 'error'}`);
      }
    }
    throw new MediaError(`No se pudo crear la imagen. ${problems.join(' · ')}`, quotaOnly ? 429 : 502);
  };
}

type PlainFetch = typeof fetch;

/** Gemini's own picture model, with the key already used for text and voice. */
export class GeminiImage {
  constructor(
    private readonly apiKey: string,
    private readonly model: string = 'gemini-2.5-flash-image',
    private readonly fetchImpl: PlainFetch = fetch,
  ) {}

  async image(prompt: string): Promise<Media> {
    let response: Response;
    try {
      response = await this.fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent`, {
        method: 'POST',
        headers: { 'x-goog-api-key': this.apiKey, 'content-type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt.slice(0, 2000) }] }], generationConfig: { responseModalities: ['IMAGE'] } }),
        signal: AbortSignal.timeout(90_000),
      });
    } catch (error) {
      throw new MediaError(`no se pudo conectar (${error instanceof Error ? error.message : 'red'})`);
    }
    const raw = await response.text();
    if (response.status === 429) throw new MediaError('cupo gratuito agotado', 429);
    if (!response.ok) throw new MediaError(`error ${response.status}: ${readGoogleError(raw)}`);
    try {
      const data = JSON.parse(raw) as { candidates?: { content?: { parts?: { inlineData?: { data?: string; mimeType?: string } }[] } }[] };
      const part = data.candidates?.[0]?.content?.parts?.find((p) => typeof p.inlineData?.data === 'string');
      if (part?.inlineData?.data !== undefined) return { mime: part.inlineData.mimeType ?? 'image/png', base64: part.inlineData.data };
    } catch {
      /* handled below */
    }
    throw new MediaError('no devolvió ninguna imagen');
  }
}

/** Pollinations: free FLUX pictures over plain HTTP, no key. Best-effort by nature. */
export class PollinationsImage {
  constructor(private readonly fetchImpl: PlainFetch = fetch) {}

  async image(prompt: string): Promise<Media> {
    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt.slice(0, 1500))}?width=1024&height=1024&nologo=true&model=flux&seed=${Math.floor(Math.random() * 1_000_000)}`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, { signal: AbortSignal.timeout(90_000) });
    } catch (error) {
      throw new MediaError(`no se pudo conectar (${error instanceof Error ? error.message : 'red'})`);
    }
    if (response.status === 429) throw new MediaError('demasiadas peticiones', 429);
    const type = response.headers.get('content-type') ?? '';
    if (!response.ok || !type.startsWith('image/')) throw new MediaError(`respondió con error ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length < 1000) throw new MediaError('devolvió una imagen vacía');
    return { mime: type.split(';')[0] ?? 'image/jpeg', base64: bytes.toString('base64') };
  }
}

/** Hugging Face Inference (free token): FLUX schnell again, on a different quota. */
export class HuggingFaceImage {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: PlainFetch = fetch,
  ) {}

  async image(prompt: string): Promise<Media> {
    let response: Response;
    try {
      response = await this.fetchImpl('https://router.huggingface.co/hf-inference/models/black-forest-labs/FLUX.1-schnell', {
        method: 'POST',
        headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json', accept: 'image/jpeg' },
        body: JSON.stringify({ inputs: prompt.slice(0, 2000) }),
        signal: AbortSignal.timeout(90_000),
      });
    } catch (error) {
      throw new MediaError(`no se pudo conectar (${error instanceof Error ? error.message : 'red'})`);
    }
    if (response.status === 429 || response.status === 402) throw new MediaError('cupo gratuito agotado', 429);
    if (response.status === 401 || response.status === 403) throw new MediaError('rechazó el token (HF_TOKEN)');
    const type = response.headers.get('content-type') ?? '';
    if (!response.ok || !type.startsWith('image/')) throw new MediaError(`respondió con error ${response.status}`);
    return { mime: type.split(';')[0] ?? 'image/jpeg', base64: Buffer.from(await response.arrayBuffer()).toString('base64') };
  }
}

/** Groq's hosted Whisper (free tier): a second way to get words and timing from a video. */
export class GroqWhisper {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: PlainFetch = fetch,
  ) {}

  async transcribe(audio: Media): Promise<{ start: number; end: number; text: string }[]> {
    const form = new FormData();
    form.append('file', new Blob([Buffer.from(audio.base64, 'base64')], { type: audio.mime }), 'audio.mp3');
    form.append('model', 'whisper-large-v3-turbo');
    form.append('response_format', 'verbose_json');
    let response: Response;
    try {
      response = await this.fetchImpl('https://api.groq.com/openai/v1/audio/transcriptions', { method: 'POST', headers: { authorization: `Bearer ${this.apiKey}` }, body: form, signal: AbortSignal.timeout(120_000) });
    } catch (error) {
      throw new MediaError(`No se pudo conectar con Groq: ${error instanceof Error ? error.message : 'red'}.`);
    }
    if (response.status === 429) throw new MediaError('Se agotó el cupo gratuito de Groq.', 429);
    if (!response.ok) throw new MediaError(`Groq respondió con error ${response.status}.`);
    const data = (await response.json()) as { segments?: { start?: number; end?: number; text?: string }[] };
    return (data.segments ?? [])
      .map((s) => ({ start: Number(s.start), end: Number(s.end), text: (s.text ?? '').trim() }))
      .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start && s.text !== '');
  }
}

/** Try each speech-to-text service in turn. */
export function chainTranscribers(steps: readonly { name: string; run(audio: Media): Promise<{ start: number; end: number; text: string }[]> }[]): ((audio: Media) => Promise<{ start: number; end: number; text: string }[]>) | undefined {
  if (steps.length === 0) return undefined;
  return async (audio) => {
    const problems: string[] = [];
    for (const step of steps) {
      try {
        const out = await step.run(audio);
        if (out.length > 0) return out;
        problems.push(`${step.name}: no encontró palabras`);
      } catch (error) {
        problems.push(`${step.name}: ${error instanceof Error ? error.message : 'error'}`);
      }
    }
    throw new MediaError(problems.join(' · '));
  };
}

export interface MediaSources {
  cloudflare?: CloudflareMedia | undefined;
  gemini?: GeminiVoice | undefined;
  extraImages?: readonly ImageStep[] | undefined;
}

/**
 * Pictures: Cloudflare first, then the backups in order. Voice: Gemini, with Cloudflare
 * (English and French) as the backup when Gemini fails. Undefined when nothing is configured.
 */
export function buildMedia(options: MediaSources): MediaGenerator | undefined {
  const { cloudflare, gemini } = options;
  const steps: ImageStep[] = [...(cloudflare !== undefined ? [{ name: 'Cloudflare', run: (p: string) => cloudflare.image(p) }] : []), ...(options.extraImages ?? [])];
  const image = steps.length > 0 ? chainImages(steps) : null;
  const cloudflareVoice = cloudflare !== undefined ? { langs: CLOUDFLARE_VOICE_LANGS, speak: (t: string, l: VoiceLang) => cloudflare.voice(t, l) } : null;
  let voice: MediaGenerator['voice'] = null;
  if (gemini !== undefined) {
    voice = {
      langs: gemini.langs,
      speak: async (text, lang) => {
        try {
          return await gemini.speak(text, lang);
        } catch (error) {
          if (cloudflareVoice !== null && cloudflareVoice.langs.includes(lang)) return cloudflareVoice.speak(text, lang);
          throw error;
        }
      },
    };
  } else voice = cloudflareVoice;
  return image === null && voice === null ? undefined : { image, voice };
}

function pick(data: unknown, key: string): string | null {
  const result = (data as { result?: Record<string, unknown> } | null)?.result;
  const value = result?.[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readError(raw: string): string {
  try {
    const first = (JSON.parse(raw) as { errors?: { message?: string }[] }).errors?.[0]?.message;
    if (typeof first === 'string') return first.slice(0, 200);
  } catch {
    /* not JSON */
  }
  return raw.slice(0, 120);
}

function readGoogleError(raw: string): string {
  try {
    const message = (JSON.parse(raw) as { error?: { message?: string } }).error?.message;
    if (typeof message === 'string') return message.slice(0, 200);
  } catch {
    /* not JSON */
  }
  return raw.slice(0, 120);
}
