/**
 * The assistant: one box where the person says what they want ("prepárame una
 * campaña de dos semanas", "haz un logo", "corta mi vídeo en 3 clips") and the app
 * does it with the tools it really has.
 *
 * A real AI provider turns the request into a short list of actions from a fixed
 * menu; the runner performs them one after another. Publishing is NOT on the menu:
 * it happens only when the person taps the button of a finished piece.
 */

import { CONTENT_VOICE_GUIDE } from '@acc/domain';
import type { ProviderRegistry } from '@acc/providers';

import { DraftError } from './draft.ts';

export type AssistantAction =
  | { type: 'create'; request: string }
  | { type: 'campaign'; topic: string; pieces: number; days: number }
  | { type: 'edit_video'; request: string };

export interface AssistantPlan {
  /** What the assistant tells the person it will do, or why it cannot. */
  reply: string;
  actions: AssistantAction[];
}

export interface AssistantContext {
  hasUploadedVideo: boolean;
}

export type AssistantPlanner = (request: string, context: AssistantContext) => Promise<AssistantPlan>;

export interface AssistantTools {
  /** One piece from a free-text request: picture, voice or video as asked. */
  create(request: string): Promise<{ itemIds: string[]; notes: string[] }>;
  /** Several dated draft pieces (with pictures) for a topic. */
  campaign(topic: string, pieces: number, days: number): Promise<{ itemIds: string[]; notes: string[] }>;
  /** Start clipping the most recently uploaded video. */
  editLatestVideo(request: string): Promise<{ notes: string[] }>;
}

export const MAX_ACTIONS = 4;

const PROMPT = `Eres el asistente de una app de marketing para una pequeña empresa. La persona escribe lo que quiere y tú decides qué acciones ejecutar con las herramientas que existen.

Herramientas (las únicas posibles):
- "create": crea UNA pieza (logo, imagen, cartel, locución, reel...). Campo: "request" = lo que hay que crear, con todos los detalles de la petición.
- "campaign": crea una campaña de varias publicaciones con fecha y foto, como borradores. Campos: "topic" = de qué va (negocio, producto, público, lugar, objetivo), "pieces" = número (3 a 7), "days" = en cuántos días repartirlas (1 a 30).
- "edit_video": corta, edita o saca clips del último vídeo que la persona subió. Campo: "request" = la edición pedida. Solo si el contexto dice que hay un vídeo subido.

Responde SOLO con JSON válido, sin texto extra ni bloques de código:
{"reply":"","actions":[{"type":"create","request":""}]}

Reglas:
- "reply": una o dos frases, en el idioma de la persona, diciendo qué vas a hacer. Sin adornos.
- Máximo ${MAX_ACTIONS} acciones. Si pide varias cosas, una acción por cosa.
- Publicar en redes NO es una acción: la persona lo aprueba después con un botón. Si lo pide, crea el contenido y dilo en "reply".
- Si pide algo que ninguna herramienta puede hacer (anuncios de pago, enviar correos, cambiar la web...), no inventes: "actions" vacío y en "reply" explica qué no se puede y qué sí puedes hacer.
- Si pide editar un vídeo y no hay ninguno subido, "actions" vacío y "reply" pide que lo suba en Creatividad.
- No inventes precios, direcciones ni datos que la persona no haya dado.

${CONTENT_VOICE_GUIDE}`;

const clip = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const bounded = (v: unknown, min: number, max: number, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : fallback);

/** Read a plan out of a model answer. Unknown actions and empty ones are dropped. Null when it is not JSON at all. */
export function parseAssistantPlan(answer: string, context: AssistantContext = { hasUploadedVideo: true }): AssistantPlan | null {
  const start = answer.indexOf('{');
  const end = answer.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(answer.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
  const actions: AssistantAction[] = [];
  for (const raw of (Array.isArray(data['actions']) ? (data['actions'] as unknown[]) : []).slice(0, MAX_ACTIONS)) {
    const a = raw as Record<string, unknown> | null;
    if (a?.['type'] === 'create' && clip(a['request'], 2000) !== '') actions.push({ type: 'create', request: clip(a['request'], 2000) });
    else if (a?.['type'] === 'campaign' && clip(a['topic'], 2000) !== '') actions.push({ type: 'campaign', topic: clip(a['topic'], 2000), pieces: bounded(a['pieces'], 1, 7, 5), days: bounded(a['days'], 1, 30, 14) });
    else if (a?.['type'] === 'edit_video' && clip(a['request'], 1500) !== '' && context.hasUploadedVideo) actions.push({ type: 'edit_video', request: clip(a['request'], 1500) });
  }
  const reply = clip(data['reply'], 600);
  if (actions.length === 0 && reply === '') return null;
  return { reply, actions };
}

export function createAssistantPlanner(providers: ProviderRegistry): AssistantPlanner {
  return async (request, context) => {
    const ask = request.trim().slice(0, 2000);
    if (ask === '') throw new DraftError('Escribe qué quieres que haga.', 400);
    const candidates = providers.availableIds().filter((id) => id !== 'mock');
    if (candidates.length === 0) throw new DraftError('No hay ninguna IA real conectada para entender la petición.', 409);
    let lastError = 'ninguna IA devolvió un plan utilizable';
    for (const id of candidates) {
      const provider = providers.get(id);
      const model = provider.listModels()[0]?.id;
      if (model === undefined) continue;
      try {
        const result = await provider.execute(
          { agentId: 'strategy', systemPrompt: PROMPT, prompt: `Contexto: ${context.hasUploadedVideo ? 'hay un vídeo subido por la persona.' : 'no hay ningún vídeo subido.'}\n\nPetición:\n${ask}\n\nEscribe ahora el JSON.`, model, temperature: 0.3, maxTokens: 1200 },
          AbortSignal.timeout(60_000),
        );
        const plan = parseAssistantPlan(result.text, context);
        if (plan !== null) return plan;
        lastError = `${provider.label} no devolvió el formato pedido`;
      } catch (error) {
        lastError = `${provider.label}: ${error instanceof Error ? error.message : 'error'}`;
      }
    }
    throw new DraftError(`No se pudo entender la petición (${lastError}). Vuelve a intentarlo en un momento.`);
  };
}

export interface AssistantOutcome {
  itemIds: string[];
  notes: string[];
}

/** Perform the actions in order. One failing action is reported and does not stop the rest. */
export async function runAssistant(plan: AssistantPlan, tools: AssistantTools, onStep: (step: string) => void): Promise<AssistantOutcome> {
  const out: AssistantOutcome = { itemIds: [], notes: [] };
  for (const [index, action] of plan.actions.entries()) {
    const label = `Paso ${index + 1} de ${plan.actions.length}`;
    try {
      if (action.type === 'create') {
        onStep(`${label}: creando`);
        const r = await tools.create(action.request);
        out.itemIds.push(...r.itemIds);
        out.notes.push(...r.notes);
      } else if (action.type === 'campaign') {
        onStep(`${label}: preparando la campaña (${action.pieces} publicaciones)`);
        const r = await tools.campaign(action.topic, action.pieces, action.days);
        out.itemIds.push(...r.itemIds);
        out.notes.push(...r.notes);
      } else {
        onStep(`${label}: editando tu vídeo`);
        out.notes.push(...(await tools.editLatestVideo(action.request)).notes);
      }
    } catch (error) {
      out.notes.push(`${label} falló: ${error instanceof Error ? error.message : 'error'}`);
    }
  }
  return out;
}

/** Evenly spread `count` publication times over the next `days` days, at 18:00 UTC, starting tomorrow. */
export function spreadDates(count: number, days: number, from: Date = new Date()): string[] {
  const dates: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const offset = count === 1 ? 1 : 1 + Math.round((i * (days - 1)) / (count - 1));
    const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate() + offset, 18, 0, 0));
    dates.push(d.toISOString());
  }
  return dates;
}
