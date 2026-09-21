/**
 * Picture and voice generation, both on free tiers.
 *
 *  - Pictures: Cloudflare Workers AI (FLUX schnell).
 *  - Voice: Gemini text-to-speech (Spanish, Italian, English, French, German,
 *    Portuguese) when a Gemini key is present; otherwise Cloudflare MeloTTS, which
 *    on Workers AI only accepts English and French.
 *
 * Keys stay on the server. Nothing is invented on failure: an error is returned
 * in words a person can act on.
 */

import type { Media } from './store.ts';

export const IMAGE_MODEL = '@cf/black-forest-labs/flux-1-schnell';
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
    const data = await this.run(IMAGE_MODEL, { prompt: prompt.slice(0, 2000), steps: 6 });
    const image = pick(data, 'image');
    if (image === null) throw new MediaError('Cloudflare no devolvió ninguna imagen. Prueba con otra descripción.');
    return { mime: image.startsWith('/9j/') ? 'image/jpeg' : 'image/png', base64: image };
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

/** Pictures from Cloudflare; voice from Gemini when it has a key, else Cloudflare. Undefined when neither is configured. */
export function buildMedia(options: { cloudflare?: CloudflareMedia | undefined; gemini?: GeminiVoice | undefined }): MediaGenerator | undefined {
  const { cloudflare, gemini } = options;
  const voice = gemini !== undefined ? gemini : cloudflare !== undefined ? { langs: CLOUDFLARE_VOICE_LANGS, speak: (t: string, l: VoiceLang) => cloudflare.voice(t, l) } : null;
  const image = cloudflare !== undefined ? (prompt: string) => cloudflare.image(prompt) : null;
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
