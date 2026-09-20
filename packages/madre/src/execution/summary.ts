/**
 * Derived facts about a run: what is blocking it, what to do next, and how far
 * to trust the result. All are computed from the run state, so they can never
 * disagree with it.
 */

import type {
  ApprovalRequest,
  Blocker,
  MadreRunState,
  MissionPlan,
  NextAction,
  QAResult,
  QAVerdict,
} from '../types.ts';
import { clamp, round } from '../util.ts';

/** Spanish agreement: "1 paso" / "3 pasos". Never "1 paso(s)". */
function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function deriveBlockers(plan: MissionPlan, state: MadreRunState, approvals: readonly ApprovalRequest[]): Blocker[] {
  const blockers: Blocker[] = [];
  const title = (id: string) => plan.steps.find((s) => s.id === id)?.title ?? id;

  for (const st of state.steps) {
    if (st.status === 'WAITING') {
      const approval = approvals.find((a) => a.id === st.waitingFor);
      blockers.push({
        stepId: st.stepId,
        kind: approval?.kind === 'input' ? 'input' : 'approval',
        reason: approval?.detail ?? `«${title(st.stepId)}» está a la espera de una decisión.`,
        resolution: approval?.kind === 'input' ? 'Aporta la información solicitada.' : 'Aprueba o deniega la solicitud.',
      });
    } else if (st.status === 'BLOCKED') {
      const kind = st.routing?.blocked?.kind;
      blockers.push({
        stepId: st.stepId,
        kind:
          kind === 'provider_missing'
            ? 'provider_missing'
            : kind === 'tool_missing'
              ? 'tool_missing'
              : kind === 'budget'
                ? 'budget'
                : kind === 'agent_planned'
                  ? 'agent_planned'
                  : kind === 'privacy'
                    ? 'provider_missing'
                    : 'dependency',
        reason: st.blockedReason ?? `«${title(st.stepId)}» no se pudo ejecutar.`,
        resolution:
          kind === 'provider_missing' || kind === 'privacy'
            ? 'Conecta un proveedor que pueda ejecutar este paso.'
            : kind === 'tool_missing'
              ? 'Conecta la herramienta que necesita este paso.'
              : kind === 'budget'
                ? 'Sube el presupuesto o permite usar un modelo local como alternativa.'
                : kind === 'agent_planned'
                  ? 'Activa el agente, que todavía no existe en esta versión.'
                  : 'Corrige el paso del que depende este y vuelve a ejecutar.',
      });
    } else if (st.status === 'FAILED') {
      blockers.push({
        stepId: st.stepId,
        kind: 'error',
        reason: `«${title(st.stepId)}» falló: ${st.error ?? 'error desconocido'}.`,
        resolution: 'Vuelve a ejecutar la misión o revisa el proveedor.',
      });
    }
  }

  for (const gap of plan.gaps.filter((g) => g.blocking)) {
    blockers.push({ stepId: null, kind: 'agent_planned', reason: gap.reason, resolution: `Necesita: ${gap.needs.join(', ') || 'una nueva capacidad'}.` });
  }
  return blockers;
}

const VERDICT_FACTOR: Record<QAVerdict, number> = { PASS: 1, PASS_WITH_WARNINGS: 0.85, NEEDS_REVISION: 0.6, BLOCKED: 0.2 };

export function latestVerdict(rounds: readonly QAResult[]): QAVerdict | null {
  return rounds.at(-1)?.verdict ?? null;
}

/**
 * Confidence in the run's result, 0..1: how well each step was routed, scaled
 * by the last QA verdict, and reduced when steps did not finish or ran without
 * live sources. Null until at least one step has finished.
 */
export function deriveConfidence(plan: MissionPlan, state: MadreRunState): number | null {
  const done = state.steps.filter((s) => s.status === 'DONE');
  if (done.length === 0) return null;
  const routed = done.map((s) => s.routing?.confidence ?? 0.5);
  const mean = routed.reduce((a, b) => a + b, 0) / routed.length;
  const verdict = latestVerdict(state.qaRounds);
  let value = mean * (verdict === null ? 0.9 : VERDICT_FACTOR[verdict]);
  const unfinished = state.steps.filter((s) => ['FAILED', 'BLOCKED', 'CANCELLED'].includes(s.status)).length;
  value *= 1 - Math.min(0.5, (unfinished / Math.max(1, plan.steps.length)) * 0.8);
  if (plan.gaps.some((g) => g.capability === 'research.web') && plan.compiled.intent.needsFreshInformation) value *= 0.9;
  return round(clamp(value, 0.02, 0.98), 2);
}

/** The single most useful thing the user can do now. */
export function deriveNextAction(plan: MissionPlan, state: MadreRunState, approvals: readonly ApprovalRequest[]): NextAction | null {
  const pending = approvals.filter((a) => a.status === 'pending');
  const input = pending.find((a) => a.kind === 'input');
  if (input !== undefined) return { kind: 'provide_input', title: input.title, detail: input.detail };
  const perm = pending.find((a) => a.kind === 'permission');
  if (perm !== undefined) return { kind: 'approve', title: perm.title, detail: perm.detail };

  if (state.phase === 'planning' || state.phase === 'executing' || state.phase === 'reviewing') return null;

  const missing = state.steps.find((s) => s.status === 'BLOCKED' && s.routing?.blocked !== null && s.routing?.blocked !== undefined);
  if (missing?.routing?.blocked) {
    const b = missing.routing.blocked;
    if (b.kind === 'provider_missing' || b.kind === 'privacy') return { kind: 'connect_provider', title: 'Conectar un proveedor', detail: b.reason };
    if (b.kind === 'tool_missing') return { kind: 'connect_tool', title: 'Conectar la herramienta que falta', detail: b.reason };
  }

  const failed = state.steps.filter((s) => s.status === 'FAILED');
  if (failed.length > 0) {
    return {
      kind: 'retry',
      title: 'Volver a ejecutar la misión',
      detail: `${failed.length === 1 ? 'Ha fallado' : 'Han fallado'} ${plural(failed.length, 'paso', 'pasos')}. ${failed[0]?.error ?? ''}`.trim(),
    };
  }

  const verdict = latestVerdict(state.qaRounds);
  const last = state.qaRounds.at(-1);
  if (verdict === 'NEEDS_REVISION' && last !== undefined) {
    const major = last.issues.filter((i) => i.severity === 'major');
    return {
      kind: 'revise',
      title: 'Revisar los problemas abiertos',
      detail: `${major.length === 1 ? 'Queda' : 'Quedan'} ${plural(major.length, 'problema', 'problemas')} tras ${plural(state.qaRounds.length, 'ronda', 'rondas')} de revisión: ${major[0]?.message ?? ''}`.trim(),
    };
  }

  const needsResearch = plan.gaps.some((g) => g.capability === 'research.web') && plan.compiled.intent.needsFreshInformation;
  if (needsResearch) {
    return {
      kind: 'run_research',
      title: 'Comprobar las afirmaciones de mercado',
      detail: 'No hay ninguna herramienta de investigación web conectada, así que las cifras de mercado proceden del conocimiento del modelo. Verifica las que condicionan la decisión o conecta una herramienta de búsqueda.',
    };
  }

  const hypothesis = plan.compiled.assumptions[0];
  if (hypothesis !== undefined && state.phase === 'completed') {
    return { kind: 'validate_assumption', title: 'Probar la hipótesis más arriesgada', detail: hypothesis.text };
  }
  return state.phase === 'completed' ? { kind: 'review_result', title: 'Leer el informe final', detail: 'La ejecución ha terminado. Revisa el informe y sus preguntas abiertas.' } : null;
}
