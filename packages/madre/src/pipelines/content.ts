/**
 * Content and distribution engine.
 *
 *   Idea → Research → Script → Visuals → Voice → Editing → QA → Publish → Analytics → Iterate
 *
 * Generation, distribution and analytics are separate groups with separate
 * ports, so making a piece of content can never publish it as a side effect.
 * Publishing always needs approval; no channel adapter is connected in this
 * build, so `publish` and `analytics` report NOT CONNECTED.
 */

import type { PermissionPolicy } from '../permissions/policy.ts';
import type { AgentRegistry } from '../registry/agents.ts';
import type { ToolRegistry } from '../registry/tools.ts';
import { assess, type PipelineReport, type StageSpec } from './stages.ts';

export const CONTENT_STAGES: readonly StageSpec[] = [
  {
    id: 'idea',
    title: 'Idea',
    group: 'generation',
    description: 'Elegir el enfoque y el público a partir de la misión.',
    agents: ['strategy', 'marketing'],
    permission: 'READ',
  },
  {
    id: 'research',
    title: 'Investigación',
    group: 'generation',
    description: 'Averiguar a qué responde ya ese público.',
    agents: ['research'],
    tools: [['web.search']],
    assist: ['research'],
    assistNote: 'El agente de Investigación puede describir al público con el conocimiento del modelo, sin fuentes en vivo. Trátalo como una hipótesis.',
    permission: 'READ',
  },
  {
    id: 'script',
    title: 'Guion',
    group: 'generation',
    description: 'Escribir el guion y los subtítulos.',
    agents: ['content'],
    assist: ['marketing'],
    assistNote: 'El agente de Marketing puede redactar el mensaje y el esquema; no hay un agente de contenido específico activo.',
    studio: ['script'],
    permission: 'READ',
  },
  {
    id: 'visuals',
    title: 'Visuales',
    group: 'generation',
    description: 'Producir las imágenes o los clips.',
    agents: ['design'],
    tools: [['media.image_generation', 'media.video_generation']],
    assist: ['design'],
    assistNote: 'El agente de Diseño puede escribir el briefing visual; no hay ningún generador de imagen o vídeo conectado para crear los materiales.',
    studio: ['image'],
    permission: 'READ',
  },
  {
    id: 'voice',
    title: 'Voz',
    group: 'generation',
    description: 'Grabar o sintetizar la locución.',
    agents: ['video'],
    tools: [['media.voice_generation']],
    studio: ['voice'],
    permission: 'READ',
  },
  {
    id: 'editing',
    title: 'Edición',
    group: 'generation',
    description: 'Cortar, subtitular y montar la pieza.',
    agents: ['video'],
    tools: [['media.ffmpeg', 'media.autoclip', 'media.moneyprinter']],
    studio: ['edit'],
    permission: 'EXECUTE',
  },
  {
    id: 'qa',
    title: 'QA y revisión de políticas',
    group: 'control',
    description: 'Revisar la pieza frente al briefing y las normas de la plataforma antes de publicar nada.',
    agents: ['qa'],
    permission: 'READ',
  },
  {
    id: 'publish',
    title: 'Publicación',
    group: 'distribution',
    description: 'Publicar en un canal a través de su API oficial.',
    agents: ['social'],
    tools: [['distribution.tiktok', 'distribution.instagram', 'distribution.youtube']],
    permission: 'PUBLISH',
  },
  {
    id: 'analytics',
    title: 'Analítica',
    group: 'analytics',
    description: 'Leer las cifras de rendimiento.',
    agents: ['social'],
    tools: [['analytics.platform']],
    permission: 'READ',
  },
  {
    id: 'iterate',
    title: 'Iteración',
    group: 'control',
    description: 'Decidir qué cambiar a partir de las cifras disponibles.',
    agents: ['strategy'],
    permission: 'READ',
  },
];

export function planContentPipeline(deps: { agents: AgentRegistry; tools: ToolRegistry; policy: PermissionPolicy; studio?: ReadonlySet<string> }): PipelineReport {
  return assess(CONTENT_STAGES, deps.agents, deps.tools, deps.policy, deps.studio);
}

// ---------------------------------------------------------------------------
// Separate ports for generation, distribution and analytics
// ---------------------------------------------------------------------------

export class NotConnectedError extends Error {
  constructor(readonly adapterId: string, what: string) {
    super(`${adapterId}: SIN CONEXIÓN para ${what}. No hay credenciales configuradas y no se ha hecho ninguna petición.`);
    this.name = 'NotConnectedError';
  }
}

export interface Post {
  title: string;
  body: string;
  mediaPaths: string[];
}

export interface DistributionPort {
  readonly id: string;
  readonly platform: string;
  readonly connected: boolean;
  publish(post: Post): Promise<{ postId: string; url: string | null }>;
}

export interface AnalyticsPort {
  readonly id: string;
  readonly platform: string;
  readonly connected: boolean;
  fetch(postId: string): Promise<{ views: number; likes: number; shares: number }>;
}

export interface GenerationPort {
  readonly id: string;
  readonly kind: 'image' | 'video' | 'voice';
  readonly connected: boolean;
  generate(prompt: string): Promise<{ path: string }>;
}

class NotConnectedAdapter implements DistributionPort, AnalyticsPort, GenerationPort {
  readonly connected = false;
  readonly kind = 'image' as const;
  constructor(readonly id: string, readonly platform: string) {}
  publish(): Promise<never> {
    return Promise.reject(new NotConnectedError(this.id, 'la publicación'));
  }
  fetch(): Promise<never> {
    return Promise.reject(new NotConnectedError(this.id, 'la analítica'));
  }
  generate(): Promise<never> {
    return Promise.reject(new NotConnectedError(this.id, 'la generación'));
  }
}

export function notConnectedDistribution(id: string, platform: string): DistributionPort {
  return new NotConnectedAdapter(id, platform);
}
export function notConnectedAnalytics(id: string, platform: string): AnalyticsPort {
  return new NotConnectedAdapter(id, platform);
}
export function notConnectedGeneration(id: string, kind: GenerationPort['kind']): GenerationPort {
  const adapter = new NotConnectedAdapter(id, kind);
  return { id, kind, connected: false, generate: () => adapter.generate() };
}

/** The adapters this build declares. All report NOT CONNECTED. */
export function createDistributionAdapters(): { distribution: DistributionPort[]; analytics: AnalyticsPort[]; generation: GenerationPort[] } {
  const platforms = [
    ['distribution.tiktok', 'TikTok'],
    ['distribution.instagram', 'Instagram'],
    ['distribution.youtube', 'YouTube'],
  ] as const;
  return {
    distribution: platforms.map(([id, name]) => notConnectedDistribution(id, name)),
    analytics: platforms.map(([id, name]) => notConnectedAnalytics(id, name)),
    generation: [
      notConnectedGeneration('media.image_generation', 'image'),
      notConnectedGeneration('media.video_generation', 'video'),
      notConnectedGeneration('media.voice_generation', 'voice'),
    ],
  };
}
