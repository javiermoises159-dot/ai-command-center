/**
 * View helpers for the MADRE screens. Pure and dependency-free so they can be
 * unit-tested without a browser. Nothing here invents data: every function maps
 * what the API returned to a label, a tone or a number.
 */

import type {
  MadreCostSummary,
  MadrePlan,
  MadreProvider,
  MadreQAVerdict,
  MadreRunState,
  MadreStepState,
  MadreStepStatus,
  MadreTool,
} from '@acc/contracts';

import { t } from '../i18n/index.ts';

export type Tone = 'neutral' | 'ok' | 'warn' | 'bad' | 'signal';

export const STEP_LABELS: Record<MadreStepStatus, string> = t.madre.stepStatus;

export function stepTone(status: MadreStepStatus): Tone {
  switch (status) {
    case 'DONE':
      return 'ok';
    case 'RUNNING':
    case 'RETRYING':
      return 'signal';
    case 'WAITING':
    case 'BLOCKED':
      return 'warn';
    case 'FAILED':
      return 'bad';
    default:
      return 'neutral';
  }
}

export const VERDICT_LABELS: Record<MadreQAVerdict, string> = t.madre.verdict;

export function verdictTone(verdict: MadreQAVerdict): Tone {
  return verdict === 'PASS' ? 'ok' : verdict === 'PASS_WITH_WARNINGS' ? 'warn' : 'bad';
}

const PHASE_LABELS: Record<MadreRunState['phase'], string> = t.madre.phase;

export function phaseLabel(phase: MadreRunState['phase']): string {
  return PHASE_LABELS[phase];
}

export function phaseTone(phase: MadreRunState['phase']): Tone {
  switch (phase) {
    case 'completed':
      return 'ok';
    case 'failed':
      return 'bad';
    case 'paused':
      return 'warn';
    case 'cancelled':
      return 'neutral';
    default:
      return 'signal';
  }
}

/** True while the engine is (or is about to be) doing work, so the UI should keep polling. */
export function runIsLive(state: MadreRunState | null): boolean {
  return state !== null && (state.phase === 'planning' || state.phase === 'executing' || state.phase === 'reviewing');
}

const SETTLED: ReadonlySet<MadreStepStatus> = new Set(['DONE', 'FAILED', 'BLOCKED', 'CANCELLED']);

export interface PlanProgress {
  done: number;
  settled: number;
  total: number;
  /** 0..1, counting every step that will not change again. */
  fraction: number;
}

export function planProgress(state: MadreRunState): PlanProgress {
  const total = state.steps.length;
  const done = state.steps.filter((s) => s.status === 'DONE').length;
  const settled = state.steps.filter((s) => SETTLED.has(s.status)).length;
  return { done, settled, total, fraction: total === 0 ? 0 : settled / total };
}

export function stepTitle(plan: MadrePlan | null, stepId: string): string {
  return plan?.steps.find((s) => s.id === stepId)?.title ?? stepId;
}

export interface ActiveStep {
  stepId: string;
  title: string;
  agentId: string;
  status: MadreStepStatus;
  provider: string | null;
  model: string | null;
}

/** Steps working right now, in plan order. */
export function activeSteps(plan: MadrePlan | null, state: MadreRunState | null): ActiveStep[] {
  if (plan === null || state === null) return [];
  const byId = new Map(state.steps.map((s) => [s.stepId, s]));
  return plan.steps.flatMap((step) => {
    const s = byId.get(step.id);
    if (s === undefined || (s.status !== 'RUNNING' && s.status !== 'RETRYING')) return [];
    return [{ stepId: step.id, title: step.title, agentId: step.agentId, status: s.status, provider: s.routing?.provider?.id ?? null, model: s.routing?.provider?.model ?? null }];
  });
}

/** Plan-ordered steps paired with their state, for the execution list. */
export function orderedSteps(plan: MadrePlan | null, state: MadreRunState | null): { step: MadrePlan['steps'][number]; state: MadreStepState | null }[] {
  if (plan === null) return [];
  const byId = new Map((state?.steps ?? []).map((s) => [s.stepId, s]));
  return plan.steps.map((step) => ({ step, state: byId.get(step.id) ?? null }));
}

export function formatUsd(value: number | null): string {
  if (value === null) return t.madre.cost.unknown;
  if (value === 0) return '$0';
  return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

/** "$0" for free providers, a lower-bound marker when some calls had no price. */
export function costLabel(cost: MadreCostSummary): string {
  if (cost.calls === 0) return t.madre.cost.noCalls;
  const base = formatUsd(cost.knownUsd);
  return cost.unpricedCalls > 0 ? t.madre.cost.atLeast(base, cost.unpricedCalls) : base;
}

export function confidenceLabel(value: number | null): string {
  return value === null ? t.madre.confidence.notAvailable : `${Math.round(value * 100)}%`;
}

export function confidenceTone(value: number | null): Tone {
  if (value === null) return 'neutral';
  return value >= 0.75 ? 'ok' : value >= 0.4 ? 'warn' : 'bad';
}

export function providerTone(status: MadreProvider['status']): Tone {
  switch (status) {
    case 'CONNECTED':
    case 'LOCAL':
      return 'ok';
    case 'MOCK':
    case 'UNCONFIGURED':
      return 'warn';
    case 'ERROR':
      return 'bad';
    default:
      return 'neutral';
  }
}

export const PROVIDER_STATUS_LABELS: Record<MadreProvider['status'], string> = t.madre.providerStatus;

export function toolTone(status: MadreTool['status']): Tone {
  switch (status) {
    case 'AVAILABLE':
    case 'CONNECTED':
      return 'ok';
    case 'MOCK':
      return 'warn';
    case 'DISABLED':
      return 'bad';
    default:
      return 'neutral';
  }
}

export const TOOL_STATUS_LABELS: Record<MadreTool['status'], string> = t.madre.toolStatus;

export function titleCase(text: string): string {
  return text.replace(/[_.]/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}
