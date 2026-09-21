/**
 * Picture and voice generation on Cloudflare Workers AI (free daily allowance).
 *
 * The key stays on the server. Nothing is invented on failure: an error is
 * returned in words a person can act on.
 */

import type { Media } from './store.ts';

export const IMAGE_MODEL = '@cf/black-forest-labs/flux-1-schnell';
export const VOICE_MODEL = '@cf/myshell-ai/melotts';
/** MeloTTS languages. Italian is not among them. */
export const VOICE_LANGS = ['es', 'en', 'fr', 'zh', 'ja', 'ko'] as const;
export type VoiceLang = (typeof VOICE_LANGS)[number];

export class MediaError extends Error {
  constructor(message: string, readonly status = 502) {
    super(message);
    this.name = 'MediaError';
  }
}

export interface MediaGenerator {
  image(prompt: string): Promise<Media>;
  voice(text: string, lang: VoiceLang): Promise<Media>;
}

export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export class CloudflareMedia implements MediaGenerator {
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
    const data = await this.run(VOICE_MODEL, { prompt: text.slice(0, 1500), lang });
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
