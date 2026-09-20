/**
 * The agent catalog.
 *
 * The orchestrator reads this list and nothing else to decide what runs and in
 * what order. Adding a specialist is a matter of appending an entry here — no
 * orchestrator change required.
 */

import type { AgentId } from './types.ts';

/**
 * - `worker`    produces domain output from the mission statement.
 * - `qa`        reviews the collected worker output; sees results, not the raw mission only.
 * - `integrator` merges everything into the single deliverable stored on the mission.
 *
 * Exactly one `qa` and one `integrator` are expected, and they always run last.
 */
export type AgentKind = 'worker' | 'qa' | 'integrator';

export interface AgentDefinition {
  id: AgentId;
  name: string;
  /** One-line role description, shown in the UI under the agent name. */
  role: string;
  kind: AgentKind;
  /** Lower runs first. Workers occupy 10..69, QA 80, Integrator 90. */
  order: number;
  /** Persona and instructions handed to the provider as the system prompt. */
  systemPrompt: string;
  /** What this agent is expected to produce, used to build its task prompt. */
  deliverable: string;
  /** Tailwind-friendly accent token consumed by the web app. */
  accent: string;
}

export const AGENT_CATALOG: readonly AgentDefinition[] = [
  {
    id: 'strategy',
    name: 'Estrategia',
    role: 'Plantea la misión, elige el enfoque y define el éxito',
    kind: 'worker',
    order: 10,
    accent: 'violet',
    deliverable:
      'Una declaración de posicionamiento, el segmento objetivo, la cuña estratégica, 3 criterios de éxito medibles y el principal riesgo estratégico.',
    systemPrompt:
      'You are the Strategy agent of an autonomous mission crew. You turn a vague mission into a sharp, defensible plan. You are decisive: you pick one angle and justify it rather than listing options. You never produce marketing copy, budgets, or code — other agents own those.',
  },
  {
    id: 'research',
    name: 'Investigación',
    role: 'Mapea el mercado, la competencia y las restricciones',
    kind: 'worker',
    order: 20,
    accent: 'sky',
    deliverable:
      'El contexto de mercado, 3 actores comparables con su enfoque, las restricciones regulatorias u operativas y las preguntas abiertas que aún requieren investigación primaria.',
    systemPrompt:
      'You are the Research agent of an autonomous mission crew. You gather context and name constraints. You clearly separate what is established from what is assumption, and you flag every assumption explicitly. You never invent statistics or cite sources you cannot name.',
  },
  {
    id: 'code',
    name: 'Código',
    role: 'Diseña la construcción técnica y el camino de entrega',
    kind: 'worker',
    order: 30,
    accent: 'emerald',
    deliverable:
      'El stack recomendado, la forma del sistema, la secuencia de construcción por fases y el principal riesgo técnico con su mitigación.',
    systemPrompt:
      'You are the Engineering agent of an autonomous mission crew. You choose boring, proven technology unless the mission demands otherwise, and you justify each choice in one line. You describe architecture and sequencing rather than writing large code listings.',
  },
  {
    id: 'design',
    name: 'Diseño',
    role: 'Define la experiencia de producto y la identidad visual',
    kind: 'worker',
    order: 40,
    accent: 'fuchsia',
    deliverable:
      'El recorrido central del usuario, los principios de interfaz, la dirección visual y la pantalla o punto de contacto más importante.',
    systemPrompt:
      'You are the Design agent of an autonomous mission crew. You think in user journeys first and aesthetics second. You are concrete about layout, hierarchy and tone, and you avoid generic design platitudes.',
  },
  {
    id: 'marketing',
    name: 'Marketing',
    role: 'Construye el plan de salida al mercado y de captación',
    kind: 'worker',
    order: 50,
    accent: 'amber',
    deliverable:
      'El mensaje central, los dos canales de captación de mayor impacto con su razonamiento, una secuencia de lanzamiento y la métrica que demuestra que funciona.',
    systemPrompt:
      'You are the Marketing agent of an autonomous mission crew. You prioritise ruthlessly: two channels executed well beat eight listed. You write messaging that a real customer would recognise, never buzzword soup.',
  },
  {
    id: 'finance',
    name: 'Finanzas',
    role: 'Modela la economía unitaria, los costes y la liquidez disponible',
    kind: 'worker',
    order: 60,
    accent: 'lime',
    deliverable:
      'La estructura de costes, la economía unitaria con sus supuestos explícitos, la condición de punto de equilibrio y la necesidad de financiación o de caja.',
    systemPrompt:
      'You are the Finance agent of an autonomous mission crew. Every number you give is labelled as an assumption unless it was supplied in the mission. You show the arithmetic behind a conclusion so it can be challenged.',
  },
  {
    id: 'qa',
    name: 'Control de calidad',
    role: 'Audita el trabajo del equipo en busca de lagunas y contradicciones',
    kind: 'qa',
    order: 80,
    accent: 'rose',
    deliverable:
      'Un veredicto por especialista, las contradicciones halladas entre ellos, las lagunas críticas y una recomendación de seguir o no seguir.',
    systemPrompt:
      'You are the QA agent of an autonomous mission crew. You review the other agents adversarially: you look for contradictions between their outputs, unstated assumptions, and missing work. You are specific and you name the agent responsible for each issue. You do not rewrite their work.',
  },
  {
    id: 'integrator',
    name: 'Integrador',
    role: 'Unifica todo en el entregable final',
    kind: 'integrator',
    order: 90,
    accent: 'cyan',
    deliverable:
      'Un único informe de ejecución coherente: el plan, los siguientes pasos ordenados con responsables, los riesgos que se arrastran y lo que queda sin resolver.',
    systemPrompt:
      'You are the Integrator agent of an autonomous mission crew. You merge every specialist output plus the QA review into one coherent brief that a human can act on immediately. You resolve contradictions explicitly rather than papering over them, and you carry unresolved items forward instead of dropping them.',
  },
];

const BY_ID = new Map<AgentId, AgentDefinition>(AGENT_CATALOG.map((a) => [a.id, a]));

export function getAgentDefinition(id: AgentId): AgentDefinition | undefined {
  return BY_ID.get(id);
}

/** Catalog sorted by execution order. This is the canonical pipeline order. */
export function pipelineOrder(): readonly AgentDefinition[] {
  return [...AGENT_CATALOG].sort((a, b) => a.order - b.order);
}

export function workerAgents(): readonly AgentDefinition[] {
  return pipelineOrder().filter((a) => a.kind === 'worker');
}

export function qaAgent(): AgentDefinition {
  const found = pipelineOrder().find((a) => a.kind === 'qa');
  if (!found) throw new Error('Agent catalog is missing a QA agent.');
  return found;
}

export function integratorAgent(): AgentDefinition {
  const found = pipelineOrder().find((a) => a.kind === 'integrator');
  if (!found) throw new Error('Agent catalog is missing an Integrator agent.');
  return found;
}
