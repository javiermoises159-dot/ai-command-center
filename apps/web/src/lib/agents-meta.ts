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
  strategy: { icon: 'compass', capabilities: ['Positioning', 'Target segment', 'Success criteria', 'Strategic risk'] },
  research: { icon: 'search', capabilities: ['Market context', 'Competitors', 'Constraints', 'Open questions'] },
  code: { icon: 'code', capabilities: ['Stack choice', 'System shape', 'Build phases', 'Technical risk'] },
  design: { icon: 'pen', capabilities: ['User journey', 'Interface principles', 'Visual direction', 'Key screen'] },
  marketing: { icon: 'megaphone', capabilities: ['Core message', 'Channels', 'Launch sequence', 'Success metric'] },
  finance: { icon: 'trending-up', capabilities: ['Cost structure', 'Unit economics', 'Break-even', 'Funding need'] },
  qa: { icon: 'shield-check', capabilities: ['Per-agent verdicts', 'Contradictions', 'Gaps', 'Go / no-go'] },
  integrator: { icon: 'layers', capabilities: ['Execution brief', 'Next actions', 'Carried risks', 'Open items'] },
};

const FALLBACK: AgentMeta = { icon: 'bot', capabilities: [] };

export function agentMeta(agentId: string): AgentMeta {
  return META[agentId] ?? FALLBACK;
}
