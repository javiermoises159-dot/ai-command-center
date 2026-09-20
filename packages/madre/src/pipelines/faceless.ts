/**
 * Faceless content factory.
 *
 * Plans a channel that publishes content without a presenter on camera. The
 * plan is a content pipeline plus a compliance gate. Nothing here estimates
 * income: revenue from content is unknown until it is measured, and the plan
 * says so.
 *
 * The gate lists what the operator must confirm. Each item is `unknown` until
 * the operator confirms it by id; publishing is only ever *allowed* when every
 * item is confirmed AND a channel is connected, and even then it needs approval.
 */

import type { PermissionPolicy } from '../permissions/policy.ts';
import type { AgentRegistry } from '../registry/agents.ts';
import type { ToolRegistry } from '../registry/tools.ts';
import { planContentPipeline } from './content.ts';
import type { PipelineReport } from './stages.ts';

export interface ComplianceItem {
  id: string;
  requirement: string;
  status: 'confirmed' | 'unknown';
}

export const COMPLIANCE_REQUIREMENTS: readonly { id: string; requirement: string }[] = [
  { id: 'platform-rules', requirement: 'He leído las normas vigentes de la plataforma sobre contenido automatizado, repetitivo o producido en masa, y este plan las cumple.' },
  { id: 'disclosure', requirement: 'El material sintético o generado con IA se etiqueta allí donde la plataforma o la ley lo exigen.' },
  { id: 'asset-rights', requirement: 'Cada clip, imagen, pista musical y voz que se usa está licenciada o creada para este uso.' },
  { id: 'no-deception', requirement: 'El canal no presenta como reales personas inventadas, testimonios falsos ni afirmaciones engañosas.' },
  { id: 'accounts', requirement: 'Todas las cuentas que se usan son mías o estoy autorizado a operarlas.' },
  { id: 'no-income-claims', requirement: 'El canal no promete ganancias y yo no doy por esperada ninguna cifra de ingresos.' },
];

export interface FacelessPlan {
  niche: string;
  pipeline: PipelineReport;
  compliance: ComplianceItem[];
  /** Publishing is allowed only when this is true. It is never true in this build. */
  publishAllowed: boolean;
  blockers: string[];
  revenueNote: string;
  cadenceNote: string;
}

export function planFacelessFactory(
  input: { niche: string; confirmations?: readonly string[] },
  deps: { agents: AgentRegistry; tools: ToolRegistry; policy: PermissionPolicy },
): FacelessPlan {
  const confirmed = new Set(input.confirmations ?? []);
  const compliance: ComplianceItem[] = COMPLIANCE_REQUIREMENTS.map((r) => ({ ...r, status: confirmed.has(r.id) ? 'confirmed' : 'unknown' }));
  const pipeline = planContentPipeline(deps);

  const blockers: string[] = [];
  const open = compliance.filter((c) => c.status !== 'confirmed');
  if (open.length > 0) {
    const single = open.length === 1;
    blockers.push(
      `${open.length} ${single ? 'requisito de cumplimiento sin confirmar' : 'requisitos de cumplimiento sin confirmar'}: ${open.map((c) => c.id).join(', ')}.`,
    );
  }
  const publish = pipeline.stages.find((s) => s.id === 'publish');
  if (publish !== undefined && publish.status !== 'ready') blockers.push('No hay ningún canal de publicación conectado.');

  return {
    niche: input.niche,
    pipeline,
    compliance,
    publishAllowed: blockers.length === 0,
    blockers,
    revenueNote: 'No se da por supuesto ningún ingreso. Lo que genera el contenido se desconoce hasta que se mide, y este plan no incluye ninguna cifra de ingresos.',
    cadenceNote: 'Empieza con pocas piezas y mide la atención que gana cada una antes de escalar. El volumen sin un formato que funcione solo produce volumen.',
  };
}
