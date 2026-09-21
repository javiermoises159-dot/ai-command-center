/**
 * The creative studio: the person types what they want ("un logo para mi tienda de
 * cookies", "un reel sobre la oferta del viernes") and the AI decides what to make.
 *
 * This file only turns the request into a brief (what to generate, and the texts);
 * the routes then run the real generators (picture, voice, video) on it. A real AI
 * provider is required: a simulated one would invent things.
 */

import { CONTENT_VOICE_GUIDE, PHOTO_STYLE_GUIDE, VISUAL_CRAFT_GUIDE } from '@acc/domain';
import type { ProviderRegistry } from '@acc/providers';

import { DraftError, realProviderIds } from './draft.ts';
import { ALL_VOICE_LANGS, type VoiceLang } from './media.ts';
import { PLATFORMS, type Platform } from './store.ts';

export type Wants = 'image' | 'voice' | 'video';

export interface StudioBrief {
  wants: Wants[];
  title: string;
  platform: Platform;
  caption: string;
  voiceText: string;
  imagePrompt: string;
  lang: VoiceLang;
}

export type StudioBriefer = (request: string) => Promise<StudioBrief>;

const SYSTEM_PROMPT = `Eres el estudio creativo de una pequeña empresa. La persona te pide algo (un logo, una imagen, un cartel, una locución, un reel...) y tú preparas lo necesario para que las herramientas lo generen.

Responde SOLO con un objeto JSON válido, sin texto extra ni bloques de código:
{"wants":["image"],"title":"","platform":"instagram","caption":"","voiceText":"","imagePrompt":"","lang":"es"}

Reglas:
- "wants": lista con lo que hay que generar, de entre "image", "voice", "video". Un logo, foto, cartel o imagen: ["image"]. Solo una locución o audio: ["voice"]. Un vídeo, reel o short: ["image","voice","video"]. Ante la duda, ["image"].
- "title": nombre corto (máximo 6 palabras).
- "platform": instagram, facebook, tiktok, youtube o telegram (instagram si no se dice).
- "caption": texto para publicar con la pieza y 3 a 6 hashtags; puede ir vacío si es solo un logo.
- "voiceText": guion que se dirá en voz alta (45 a 70 palabras, frases cortas). Vacío si no hace falta voz.
- "imagePrompt": descripción visual detallada en inglés (sujeto, fondo, luz, colores). ${PHOTO_STYLE_GUIDE} Para un logo: un emblema o símbolo sencillo, estilo vectorial plano, pocos colores, fondo liso y claro, centrado; NO pidas letras ni palabras dentro de la imagen porque el generador las deforma.
- "lang": idioma de la voz y los textos: es, it, en, fr, de o pt (el de la petición, o el del público si lo dice).
- No inventes precios, direcciones, teléfonos ni datos que la persona no haya dado.

${CONTENT_VOICE_GUIDE}

Para logos y diseños:
${VISUAL_CRAFT_GUIDE}`;

const clip = (value: unknown, max: number): string => (typeof value === 'string' ? value.trim().slice(0, max) : '');

/** Read a brief out of a model answer, tolerating code fences and chatter. Returns null when unusable. */
export function parseBrief(answer: string): StudioBrief | null {
  const start = answer.indexOf('{');
  const end = answer.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(answer.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
  const requested = Array.isArray(data['wants']) ? (data['wants'] as unknown[]) : [];
  const asked = (['image', 'voice', 'video'] as const).filter((w) => requested.includes(w));
  // A video is made from a picture and a voice, so asking for one asks for all three.
  const wants = asked.includes('video') ? (['image', 'voice', 'video'] as const) : asked;
  const imagePrompt = clip(data['imagePrompt'], 1500);
  const voiceText = clip(data['voiceText'], 1500);
  // Something to generate must have the text it is generated from.
  const usable = wants.filter((w) => (w === 'image' ? imagePrompt !== '' : voiceText !== ''));
  if (usable.length === 0 || (wants.includes('video') && usable.length < 3)) return null;
  const title = clip(data['title'], 120) || 'Creación del estudio';
  const platform = (PLATFORMS as readonly string[]).includes(String(data['platform'])) ? (data['platform'] as Platform) : 'instagram';
  const lang = (ALL_VOICE_LANGS as readonly string[]).includes(String(data['lang'])) ? (data['lang'] as VoiceLang) : 'es';
  return { wants: usable, title, platform, caption: clip(data['caption'], 4000), voiceText, imagePrompt, lang };
}

export function createStudioBriefer(providers: ProviderRegistry): StudioBriefer {
  return async (request) => {
    const ask = request.trim().slice(0, 2000);
    if (ask === '') throw new DraftError('Escribe qué quieres crear.', 400);
    const candidates = realProviderIds(providers);
    if (candidates.length === 0) throw new DraftError('No hay ninguna IA real conectada para preparar la creación.', 409);

    let lastError = 'ninguna IA devolvió algo utilizable';
    for (const id of candidates) {
      const provider = providers.get(id);
      const model = provider.listModels()[0]?.id;
      if (model === undefined) continue;
      try {
        const result = await provider.execute(
          { agentId: 'design', systemPrompt: SYSTEM_PROMPT, prompt: `Petición de la persona:\n\n${ask}\n\nEscribe ahora el JSON.`, model, temperature: 0.5, maxTokens: 1500 },
          AbortSignal.timeout(60_000),
        );
        const brief = parseBrief(result.text);
        if (brief !== null) return brief;
        lastError = `${provider.label} no devolvió el formato pedido`;
      } catch (error) {
        lastError = `${provider.label}: ${error instanceof Error ? error.message : 'error'}`;
      }
    }
    throw new DraftError(`No se pudo preparar la creación (${lastError}). Vuelve a intentarlo en un momento.`);
  };
}
