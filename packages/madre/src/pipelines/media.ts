/**
 * Video and media pipeline, local first.
 *
 * Whisper, FFmpeg, AutoClip and MoneyPrinterTurbo are the preferred tools
 * because they run on the user's machine at no per-use cost; hosted image,
 * voice and video services come after. Every tool here is PLANNED or NOT
 * CONNECTED, so the report shows what a media job would need, not that it can
 * run.
 */

import type { PermissionPolicy } from '../permissions/policy.ts';
import type { AgentRegistry } from '../registry/agents.ts';
import type { ToolRegistry } from '../registry/tools.ts';
import { assess, type PipelineReport, type StageSpec } from './stages.ts';

export const MEDIA_STAGES: readonly StageSpec[] = [
  { id: 'ingest', title: 'Incorporar el material de origen', group: 'generation', description: 'Colocar los archivos de origen en el sandbox.', tools: [['sandbox.files']], studio: ['edit'], permission: 'WRITE' },
  { id: 'transcribe', title: 'Transcribir', group: 'generation', description: 'Convertir el habla en texto con marcas de tiempo en esta máquina.', agents: ['video'], tools: [['media.whisper']], studio: ['transcribe'], permission: 'EXECUTE' },
  { id: 'clip', title: 'Localizar y cortar clips', group: 'generation', description: 'Elegir los mejores fragmentos y cortarlos.', agents: ['video'], tools: [['media.autoclip', 'media.ffmpeg']], studio: ['edit'], permission: 'EXECUTE' },
  { id: 'assemble', title: 'Montar un vídeo a partir de un guion', group: 'generation', description: 'Combinar guion, metraje, voz y subtítulos.', agents: ['video'], tools: [['media.moneyprinter', 'media.ffmpeg']], studio: ['reel'], permission: 'EXECUTE' },
  { id: 'captions', title: 'Subtitular', group: 'generation', description: 'Incrustar o adjuntar los subtítulos.', agents: ['video'], tools: [['media.whisper'], ['media.ffmpeg']], studio: ['edit', 'transcribe'], permission: 'EXECUTE' },
  { id: 'export', title: 'Exportar al sandbox', group: 'generation', description: 'Escribir los archivos terminados en la carpeta de salidas.', tools: [['sandbox.files']], studio: ['edit'], permission: 'WRITE' },
];

export function planMediaPipeline(deps: { agents: AgentRegistry; tools: ToolRegistry; policy: PermissionPolicy; studio?: ReadonlySet<string> }): PipelineReport & { localFirst: string[] } {
  const report = assess(MEDIA_STAGES, deps.agents, deps.tools, deps.policy, deps.studio);
  return { ...report, localFirst: ['media.whisper', 'media.ffmpeg', 'media.autoclip', 'media.moneyprinter'] };
}
