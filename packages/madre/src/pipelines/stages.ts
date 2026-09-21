/**
 * Pipeline stages and readiness.
 *
 * A pipeline (content, media, faceless) is a list of stages. Each stage says
 * what it needs — agents and tools — and readiness is computed from the live
 * registries, so the plan tells the truth about what can run today, what can
 * run partly, and what is blocked and by what.
 */

import type { PermissionPolicy } from '../permissions/policy.ts';
import type { AgentRegistry } from '../registry/agents.ts';
import type { ToolRegistry } from '../registry/tools.ts';
import type { PermissionLevel } from '../types.ts';

export type StageGroup = 'generation' | 'distribution' | 'analytics' | 'control';

export interface StageSpec {
  id: string;
  title: string;
  group: StageGroup;
  description: string;
  /** Any one active agent from this list can do the thinking. Empty = no agent needed. */
  agents?: string[];
  /** Every group needs one usable tool from it: [[a, b], [c]] means (a or b) and c. */
  tools?: string[][];
  /** Agents that can stand in for a missing tool by producing a brief or draft. */
  assist?: string[];
  /** What the stand-in produces, shown to the user. */
  assistNote?: string;
  /**
   * Studio capabilities (all needed) that do this stage when the PERSON asks for it in
   * the app's creative studio. They are real, but not called by agents on their own, so
   * they make the stage ready without lifting any agent permission.
   */
  studio?: string[];
  permission: PermissionLevel;
}

export type StageStatus = 'ready' | 'partial' | 'blocked';

/** Concordancia de número para los textos que ve el usuario. */
function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

export interface StageReadiness {
  id: string;
  title: string;
  group: StageGroup;
  status: StageStatus;
  /** Ids of agents or tools that are missing or not connected. */
  missing: string[];
  note: string;
  /** True when running the stage would need a person's approval. */
  needsApproval: boolean;
  blockedByPolicy: boolean;
}

export interface PipelineReport {
  stages: StageReadiness[];
  ready: number;
  partial: number;
  blocked: number;
  /** Plain-language summary. */
  summary: string;
}

export function assess(specs: readonly StageSpec[], agents: AgentRegistry, tools: ToolRegistry, policy: PermissionPolicy, studio: ReadonlySet<string> = new Set()): PipelineReport {
  const stages: StageReadiness[] = specs.map((spec) => {
    if (spec.studio !== undefined && spec.studio.every((c) => studio.has(c))) {
      return {
        id: spec.id,
        title: spec.title,
        group: spec.group,
        status: 'ready' as const,
        missing: [],
        note: `${spec.description} Lo hace el Estudio de Creatividad cuando tú se lo pides; los agentes no lo lanzan por su cuenta.`,
        needsApproval: false,
        blockedByPolicy: false,
      };
    }

    const missing: string[] = [];
    const agentOk = spec.agents === undefined || spec.agents.length === 0 || spec.agents.some((id) => agents.get(id)?.status === 'active');
    if (!agentOk) missing.push(...(spec.agents ?? []).map((id) => `agent:${id}`));

    const toolGroups = spec.tools ?? [];
    let toolsOk = true;
    for (const group of toolGroups) {
      if (!group.some((id) => tools.isUsable(id))) {
        toolsOk = false;
        missing.push(...group);
      }
    }

    const decision = policy.evaluate({ level: spec.permission, subject: spec.id, description: spec.title, internal: spec.permission === 'WRITE' });
    const assistOk = spec.assist?.some((id) => agents.get(id)?.status === 'active') === true;

    let status: StageStatus;
    let note: string;
    if (agentOk && toolsOk) {
      status = 'ready';
      note = spec.description;
    } else if (assistOk) {
      status = 'partial';
      note = spec.assistNote ?? 'Un agente activo puede prepararlo, pero la herramienta que lo llevaría a cabo no está conectada.';
    } else {
      status = 'blocked';
      const absent = [...new Set(missing)];
      note = `No se puede ejecutar: ${absent.join(', ')} no ${plural(absent.length, 'está disponible', 'están disponibles')}.`;
    }
    if (decision.mode === 'BLOCK') {
      status = 'blocked';
      note = `Bloqueado por permisos. ${decision.reason}`;
    }

    return {
      id: spec.id,
      title: spec.title,
      group: spec.group,
      status,
      missing: [...new Set(missing)],
      note,
      needsApproval: decision.mode === 'ASK',
      blockedByPolicy: decision.mode === 'BLOCK',
    };
  });

  const count = (s: StageStatus) => stages.filter((x) => x.status === s).length;
  const ready = count('ready');
  const partial = count('partial');
  const blocked = count('blocked');
  return {
    stages,
    ready,
    partial,
    blocked,
    summary:
      `${ready} de ${stages.length} ${plural(stages.length, 'etapa', 'etapas')} ${plural(ready, 'puede', 'pueden')} ejecutarse hoy, ` +
      `${partial} ${plural(partial, 'puede', 'pueden')} prepararse pero no llevarse a cabo, ` +
      `${blocked} ${plural(blocked, 'está bloqueada', 'están bloqueadas')}.`,
  };
}
