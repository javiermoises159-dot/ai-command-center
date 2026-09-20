/**
 * Presentation metadata for the eight agents.
 *
 * The API owns what an agent *is* (id, name, role, deliverable, accent). It has
 * no notion of an icon or of short capability tags, because those are purely a
 * display concern — so they live here, in the frontend, keyed by agent id. An
 * agent id the frontend does not know yet still renders, with a neutral icon and
 * no tags, instead of breaking the screen.
 *
 * The capability tags below restate each agent's catalog deliverable in short
 * form; they are UI labels, not something the API returns.
 */

import type { IconName } from '../components/icons.tsx';

export interface AgentMeta {
  icon: IconName;
  capabilities: string[];
}

const META: Record<string, AgentMeta> = {
  strategy: { icon: 'compass', capabilities: ['Posicionamiento', 'Segmento objetivo', 'Criterios de éxito', 'Riesgo estratégico'] },
  research: { icon: 'search', capabilities: ['Contexto de mercado', 'Competencia', 'Restricciones', 'Preguntas abiertas'] },
  engineering: { icon: 'code', capabilities: ['Arquitectura', 'Elección de stack', 'Fases de construcción', 'Riesgo técnico'] },
  content: { icon: 'pen', capabilities: [] },
  video: { icon: 'video', capabilities: [] },
  social: { icon: 'megaphone', capabilities: [] },
  sales: { icon: 'trending-up', capabilities: [] },
  browser: { icon: 'globe', capabilities: [] },
  computer_use: { icon: 'monitor', capabilities: [] },
  data: { icon: 'table', capabilities: [] },
  legal: { icon: 'file-text', capabilities: [] },
  automation: { icon: 'zap', capabilities: [] },
  trading_research: { icon: 'trending-up', capabilities: [] },
  code: { icon: 'code', capabilities: ['Elección de stack', 'Forma del sistema', 'Fases de construcción', 'Riesgo técnico'] },
  design: { icon: 'pen', capabilities: ['Recorrido del usuario', 'Principios de interfaz', 'Dirección visual', 'Pantalla clave'] },
  marketing: { icon: 'megaphone', capabilities: ['Mensaje principal', 'Canales', 'Secuencia de lanzamiento', 'Métrica de éxito'] },
  finance: { icon: 'trending-up', capabilities: ['Estructura de costes', 'Economía unitaria', 'Punto de equilibrio', 'Necesidad de financiación'] },
  qa: { icon: 'shield-check', capabilities: ['Veredicto por agente', 'Contradicciones', 'Lagunas', 'Seguir o parar'] },
  integrator: { icon: 'layers', capabilities: ['Informe de ejecución', 'Próximas acciones', 'Riesgos heredados', 'Puntos abiertos'] },
};

const FALLBACK: AgentMeta = { icon: 'bot', capabilities: [] };

export function agentMeta(agentId: string): AgentMeta {
  return META[agentId] ?? FALLBACK;
}
