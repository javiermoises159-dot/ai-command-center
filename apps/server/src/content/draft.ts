/**
 * Turn a finished mission report into content pieces (title, text, spoken script,
 * picture description) ready for the calendar.
 *
 * One call to a real AI provider, with the same free providers the crew uses: the
 * providers are tried in turn until one answers with usable JSON. Nothing is
 * published and nothing is dated — the pieces arrive as drafts for the person to
 * review, which is the point.
 */

import { CONTENT_VOICE_GUIDE, PHOTO_STYLE_GUIDE } from '@acc/domain';
import type { ProviderRegistry } from '@acc/providers';

import { PLATFORMS, type ContentInput, type Platform } from './store.ts';

export class DraftError extends Error {
  constructor(message: string, readonly status = 502) {
    super(message);
    this.name = 'DraftError';
  }
}

export type PieceDrafter = (report: string) => Promise<ContentInput[]>;

const MAX_REPORT_CHARS = 12_000;

const SYSTEM_PROMPT = `Eres el agente de contenido de una pequeña empresa. A partir del informe de una misión escribes piezas listas para publicar en redes sociales.

Responde SOLO con un objeto JSON válido, sin texto antes ni después y sin bloques de código, con esta forma exacta:
{"pieces":[{"title":"","platform":"instagram","caption":"","voiceText":"","imagePrompt":""}]}

Reglas:
- Entre 3 y 5 piezas, cada una con un enfoque distinto (presentación, producto, confianza, invitación a comprar...).
- "platform" es uno de: instagram, facebook, tiktok, youtube, telegram.
- "title": nombre corto de la pieza, para uso interno.
- "caption": el texto de la publicación, con 3 a 6 hashtags al final.
- "voiceText": el guion que se dirá en voz alta, de 45 a 70 palabras (unos 20 segundos), con frases cortas y puntuación clara.
- "imagePrompt": descripción visual concreta de la imagen (objeto, fondo, luz, colores). ${PHOTO_STYLE_GUIDE}
- Escribe caption y voiceText en el idioma del público al que se dirige el informe (italiano si el negocio está en Italia; si no queda claro, español).
- No inventes precios, descuentos, direcciones, teléfonos, plazos ni datos que el informe no diga. Si falta un dato, no lo menciones.
- No prometas nada que el informe no respalde.

${CONTENT_VOICE_GUIDE}`;

/** The report without its embedded web page or other code blocks, and not too long. */
export function reportForDrafting(report: string): string {
  return report.replace(/```[\s\S]*?```/g, ' [bloque de código omitido] ').replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX_REPORT_CHARS);
}

const clip = (value: unknown, max: number): string => (typeof value === 'string' ? value.trim().slice(0, max) : '');

/** Pull the pieces out of a model answer, tolerating code fences and stray text. Bad entries are dropped. */
export function parsePieces(answer: string): ContentInput[] {
  const start = answer.indexOf('{');
  const end = answer.lastIndexOf('}');
  if (start < 0 || end <= start) return [];
  let data: unknown;
  try {
    data = JSON.parse(answer.slice(start, end + 1));
  } catch {
    return [];
  }
  const list = (data as { pieces?: unknown } | null)?.pieces;
  if (!Array.isArray(list)) return [];
  const pieces: ContentInput[] = [];
  for (const raw of list.slice(0, 8)) {
    const piece = raw as Record<string, unknown> | null;
    const title = clip(piece?.['title'], 120);
    const caption = clip(piece?.['caption'], 4000);
    const voiceText = clip(piece?.['voiceText'], 1500);
    if (title === '' || (caption === '' && voiceText === '')) continue;
    const platform = (PLATFORMS as readonly string[]).includes(String(piece?.['platform'])) ? (piece?.['platform'] as Platform) : 'instagram';
    pieces.push({ title, platform, caption, voiceText, imagePrompt: clip(piece?.['imagePrompt'], 1500) });
  }
  return pieces;
}

export function createPieceDrafter(providers: ProviderRegistry): PieceDrafter {
  return async (report) => {
    const body = reportForDrafting(report);
    if (body === '') throw new DraftError('La misión no tiene informe del que sacar piezas.', 400);

    // Real providers only: a simulated answer would put invented content in the calendar.
    const candidates = providers.availableIds().filter((id) => id !== 'mock');
    if (candidates.length === 0) throw new DraftError('No hay ninguna IA real conectada para escribir las piezas.', 409);

    let lastError = 'ninguna IA devolvió piezas utilizables';
    for (const id of candidates) {
      const provider = providers.get(id);
      const model = provider.listModels()[0]?.id;
      if (model === undefined) continue;
      try {
        const result = await provider.execute(
          {
            agentId: 'marketing',
            systemPrompt: SYSTEM_PROMPT,
            prompt: `Informe de la misión:\n\n${body}\n\nEscribe ahora el JSON con las piezas.`,
            model,
            temperature: 0.6,
            maxTokens: 3000,
          },
          AbortSignal.timeout(90_000),
        );
        const pieces = parsePieces(result.text);
        if (pieces.length > 0) return pieces;
        lastError = `${provider.label} no devolvió piezas en el formato pedido`;
      } catch (error) {
        lastError = `${provider.label}: ${error instanceof Error ? error.message : 'error'}`;
      }
    }
    throw new DraftError(`No se pudieron crear las piezas (${lastError}). Vuelve a intentarlo en un momento.`);
  };
}
