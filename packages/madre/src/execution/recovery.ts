/**
 * Boot-time recovery and reconciliation.
 *
 * The in-process queue dies with the process. A run that was mid-flight then
 * leaves two records that no longer agree: the MADRE run state (the source of
 * truth: plan, every step, every result) still says `executing` with steps
 * `RUNNING`, while the legacy tables (`mission_runs`, `mission_agents`,
 * `missions`) were closed by the old sweep as `failed`. A screen that reads one
 * and an endpoint that reads the other then disagree: "mission failed, step
 * running".
 *
 * This module makes the persisted state the only authority and brings
 * everything else in line with it. Rules:
 *
 *  - Nothing is invented. A run that was mid-flight is `interrupted`, never
 *    `completed`, however much of it was done. The work that WAS persisted
 *    (finished steps and their results) is kept untouched.
 *  - A step left `RUNNING`/`RETRYING` is failed and flagged `interrupted`. A
 *    step that never started is blocked with the reason. A step waiting on a
 *    person, in a run that is being closed, is blocked and its approval denied
 *    so the inbox does not point at a dead run.
 *  - State is written FIRST, then the legacy rows are aligned to it. A crash
 *    between the two leaves a state the next boot finishes, never the reverse.
 *  - It is idempotent. Once a run is settled there is nothing left for a second
 *    pass to change, and the audit event has a fixed id per run, so running
 *    recovery twice leaves one event.
 *  - A paused run that still has a person to hear from is left alone; one whose
 *    approvals are all decided is reported as resumable so the caller can queue
 *    it.
 *  - What cannot be repaired (the legacy row is already terminal and says the
 *    opposite of the state — the legacy repositories refuse to reopen a closed
 *    run) is reported as a conflict, never papered over.
 */

import type { AgentExecutionRepository, Clock, MissionRun, Repositories } from '@acc/domain';

import type { ApprovalService } from '../permissions/approvals.ts';
import type { AuditLog } from '../audit.ts';
import type { CostController } from '../cost/controller.ts';
import type { AgentRegistry } from '../registry/agents.ts';
import { KINDS, type MadreStore } from '../store.ts';
import type { MadreRunState, MissionPlan, RecoveryOutcome, RunRecoveryRecord, StepState, StepStatus } from '../types.ts';
import { RepositoryMirror } from './mirror.ts';

export interface RecoveredRun {
  runId: string;
  missionId: string;
  outcome: RecoveryOutcome;
  retryable: boolean;
  reason: string;
  /** Steps whose status was changed. */
  stepsChanged: number;
  /** What this pass did to the record, e.g. "estado", "legacy". Empty for a no-op. */
  repaired: string[];
}

export interface RecoveryReport {
  /** Runs examined. */
  scanned: number;
  recovered: RecoveredRun[];
  /** Paused runs left alone: a person still has to decide. */
  kept: string[];
  /** Paused runs whose approvals are all decided: the caller should queue them. */
  resumable: { runId: string; missionId: string }[];
  /** Records that disagree and cannot be repaired safely. */
  conflicts: { runId: string; missionId: string; detail: string }[];
  /** Missions that said `running` with no run behind them, now reconciled. */
  missionsReconciled: string[];
}

export interface RunRecoveryDeps {
  repositories: Pick<Repositories, 'missions' | 'runs' | 'agents'>;
  store: MadreStore;
  audit: AuditLog;
  approvals: ApprovalService;
  cost: CostController;
  agents: AgentRegistry;
  clock: Clock;
  /** Runs this process is driving right now: never touched. */
  isActive?: (runId: string) => boolean;
}

/** Statuses a step can rest in once its run is over. */
const SETTLED: ReadonlySet<StepStatus> = new Set<StepStatus>(['DONE', 'FAILED', 'BLOCKED', 'CANCELLED']);
const TERMINAL_PHASES: ReadonlySet<MadreRunState['phase']> = new Set(['completed', 'failed', 'cancelled']);

const RESTARTED = 'El servidor se reinició mientras este paso estaba en ejecución.';
const NEVER_STARTED = 'La ejecución se interrumpió antes de llegar a este paso.';
const APPROVAL_ORPHANED = 'La ejecución se interrumpió antes de que se resolviera esta aprobación.';

/** How many run-state documents one pass looks at, newest first. */
const SCAN_LIMIT = 2000;

export class RunRecovery {
  constructor(private readonly d: RunRecoveryDeps) {}

  async recover(): Promise<RecoveryReport> {
    const report: RecoveryReport = { scanned: 0, recovered: [], kept: [], resumable: [], conflicts: [], missionsReconciled: [] };
    const seen = new Set<string>();

    // 1. Every run the legacy tables still call unfinished.
    const unfinished = await this.d.repositories.runs.findUnfinished();
    // 2. Every run whose state document is not closed, whatever the legacy row says
    //    (this is where "mission failed, step running" hides).
    const states = await this.d.store.list<MadreRunState>(KINDS.runState, { limit: SCAN_LIMIT, order: 'desc' });
    const openStates = states.filter((s) => !TERMINAL_PHASES.has(s.phase) || s.steps.some((st) => !SETTLED.has(st.status)));

    const runIds = [...new Set([...unfinished.map((r) => r.id), ...openStates.map((s) => s.runId)])];
    for (const runId of runIds) {
      if (seen.has(runId)) continue;
      seen.add(runId);
      if (this.d.isActive?.(runId) === true) continue;
      report.scanned++;
      try {
        await this.recoverRun(runId, report);
      } catch (error) {
        // One broken run must not stop the others from being recovered.
        const run = await this.d.repositories.runs.findById(runId).catch(() => null);
        report.conflicts.push({
          runId,
          missionId: run?.missionId ?? 'desconocida',
          detail: `No se pudo reconciliar: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }

    await this.reconcileMissions(report);
    return report;
  }

  /**
   * Every way the mission's records disagree with each other right now. Empty
   * means the mission, its runs, its agent rows and the MADRE state all tell
   * the same story. This is the contract recovery enforces, and what the
   * regression tests hold it to: "mission failed but a step still running"
   * must never be reported by a healthy system.
   */
  async inspect(missionId: string): Promise<string[]> {
    const problems: string[] = [];
    const mission = await this.d.repositories.missions.findById(missionId);
    if (mission === null) return [`La misión ${missionId} no existe.`];
    const runs = [...(await this.d.repositories.runs.listByMission(missionId))].sort((a, b) => b.attempt - a.attempt);
    const newest = runs[0];
    const missionClosed = mission.status === 'completed' || mission.status === 'failed';

    for (const run of runs) {
      const state = await this.d.store.get<MadreRunState>(KINDS.runState, run.id);
      const runClosed = run.status === 'completed' || run.status === 'failed';
      const label = `intento ${run.attempt}`;
      const agentRows = await this.d.repositories.agents.listByRun(run.id);

      if (runClosed) {
        for (const row of agentRows.filter((a) => a.status === 'running')) problems.push(`${label}: la ejecución está «${run.status}» pero el agente «${row.name}» sigue «running».`);
      }
      if (state === null) continue;

      const live = state.steps.filter((s) => !SETTLED.has(s.status));
      const paused = state.phase === 'paused';
      if (runClosed && !TERMINAL_PHASES.has(state.phase)) problems.push(`${label}: la ejecución está «${run.status}» pero el estado guardado dice «${state.phase}».`);
      if (!runClosed && TERMINAL_PHASES.has(state.phase)) problems.push(`${label}: el estado guardado dice «${state.phase}» pero la ejecución sigue «${run.status}».`);
      if (runClosed && live.length > 0 && !paused) {
        for (const st of live) problems.push(`${label}: la ejecución está «${run.status}» pero el paso «${st.stepId}» sigue «${st.status}».`);
      }
      if (TERMINAL_PHASES.has(state.phase) && live.length > 0) {
        for (const st of live) problems.push(`${label}: el estado está «${state.phase}» pero el paso «${st.stepId}» sigue «${st.status}».`);
      }
      if (runClosed && TERMINAL_PHASES.has(state.phase) && (run.status === 'completed') !== (state.phase === 'completed')) {
        problems.push(`${label}: la ejecución dice «${run.status}» y el estado guardado dice «${state.phase}».`);
      }
      if (run.id === newest?.id && missionClosed && live.length > 0) {
        for (const st of live) problems.push(`La misión está «${mission.status}» pero el paso «${st.stepId}» sigue «${st.status}».`);
      }
    }
    if (newest !== undefined) {
      const newestClosed = newest.status === 'completed' || newest.status === 'failed';
      if (mission.status === 'running' && newestClosed) problems.push(`La misión figura «running» y su última ejecución está «${newest.status}».`);
      if (missionClosed && (newest.status === 'pending' || newest.status === 'running')) problems.push(`La misión está «${mission.status}» pero su última ejecución sigue «${newest.status}».`);
    }
    return problems;
  }

  // -------------------------------------------------------------------------

  private async recoverRun(runId: string, report: RecoveryReport): Promise<void> {
    const run = await this.d.repositories.runs.findById(runId);
    if (run === null) {
      report.conflicts.push({ runId, missionId: 'desconocida', detail: 'Hay un estado guardado para una ejecución que no existe en la base de datos.' });
      return;
    }
    const state = await this.d.store.get<MadreRunState>(KINDS.runState, runId);
    const plan = await this.d.store.get<MissionPlan>(KINDS.plan, runId);

    if (state === null || plan === null) {
      await this.recoverWithoutState(run, report);
      return;
    }

    // A paused run with someone still to hear from is not a casualty.
    if (state.phase === 'paused' && !state.steps.some((s) => s.status === 'RUNNING' || s.status === 'RETRYING')) {
      const approvals = await this.d.approvals.forRun(runId);
      const stillWaiting = state.steps.some((s) => s.status === 'WAITING');
      if (stillWaiting && run.status !== 'failed' && run.status !== 'completed') {
        if (approvals.some((a) => a.status === 'pending')) report.kept.push(runId);
        else report.resumable.push({ runId, missionId: run.missionId });
        return;
      }
    }

    const wasTerminal = TERMINAL_PHASES.has(state.phase);
    const repaired: string[] = [];
    const stepChanges: RunRecoveryRecord['steps'] = [];
    let outcome: RecoveryOutcome;
    let reason: string;
    let retryable: boolean;

    if (wasTerminal && !state.steps.some((s) => !SETTLED.has(s.status))) {
      // The engine had concluded. Only the legacy closing can be missing.
      if (state.recovery !== undefined && run.status !== 'pending' && run.status !== 'running') return; // already reconciled
      outcome = state.phase === 'completed' ? 'completed' : state.phase === 'cancelled' ? 'cancelled' : 'failed';
      retryable = outcome !== 'completed';
      reason =
        state.recovery?.reason ??
        (outcome === 'completed'
          ? 'La ejecución había terminado bien; solo faltaba cerrar su registro.'
          : outcome === 'cancelled'
            ? 'La ejecución ya estaba cancelada; solo faltaba cerrar su registro.'
            : 'La ejecución ya había fallado; solo faltaba cerrar su registro.');
      if (state.recovery !== undefined) {
        outcome = state.recovery.outcome;
        retryable = state.recovery.retryable;
      }
    } else {
      // Mid-flight (or a closed state that still holds live steps): interrupted.
      const cancelled = state.phase === 'cancelled' || state.cancelRequested;
      outcome = cancelled ? 'cancelled' : 'interrupted';
      retryable = true;
      reason = cancelled
        ? 'Se había pedido cancelar la ejecución y el servidor se reinició antes de terminar de cancelarla.'
        : run.status === 'failed'
          ? 'Un reinicio anterior cerró la ejecución como fallida sin actualizar sus pasos; ahora coinciden.'
          : 'El servidor se reinició mientras la ejecución estaba en curso. Los pasos ya terminados conservan su resultado; el resto no se dio por bueno.';

      const at = this.d.clock.now().toISOString();
      for (const st of state.steps) {
        const from = st.status;
        if (SETTLED.has(from)) continue;
        if (from === 'RUNNING' || from === 'RETRYING') {
          st.status = cancelled ? 'CANCELLED' : 'FAILED';
          st.error = cancelled ? null : RESTARTED;
          st.interrupted = true;
        } else {
          st.status = cancelled ? 'CANCELLED' : 'BLOCKED';
          st.blockedReason = cancelled ? null : from === 'WAITING' ? APPROVAL_ORPHANED : NEVER_STARTED;
          st.waitingFor = null;
        }
        st.completedAt = at;
        st.history.push({ at, status: st.status, note: `Recuperado al arrancar: ${reason}` });
        stepChanges.push({ stepId: st.stepId, from, to: st.status });
      }
      if (stepChanges.length > 0) repaired.push('pasos');

      // A pending approval for a run that will never continue is a dead end in the inbox.
      for (const a of (await this.d.approvals.forRun(runId)).filter((x) => x.status === 'pending')) {
        try {
          await this.d.approvals.decide(a.id, 'denied', APPROVAL_ORPHANED);
          if (!repaired.includes('aprobaciones')) repaired.push('aprobaciones');
        } catch (error) {
          report.conflicts.push({ runId, missionId: run.missionId, detail: `No se pudo cerrar la aprobación «${a.title}»: ${error instanceof Error ? error.message : String(error)}` });
        }
      }

      state.phase = cancelled ? 'cancelled' : 'failed';
      state.completedAt ??= at;
      state.updatedAt = at;
      state.cost = await this.d.cost.summary({ runId }).catch(() => state.cost);
      const record: RunRecoveryRecord = { at, outcome, retryable, reason, steps: stepChanges };
      state.recovery = record;
      // The persisted state is written before anything else is touched.
      await this.d.store.put(KINDS.runState, runId, state, { missionId: state.missionId, runId });
      repaired.push('estado');
    }

    // Legacy rows follow the state.
    const legacyBefore = run.status;
    await this.alignLegacy(run, plan, state, outcome, reason, report);
    if (legacyBefore === 'pending' || legacyBefore === 'running') repaired.push('registro heredado');

    if (repaired.length === 0) return;
    await this.d.audit.recordOnce(
      `recovery-${runId}`,
      'engine',
      'run.recovered',
      `Recuperada al arrancar: ${reason}`,
      { missionId: run.missionId, runId },
      { outcome, retryable, steps: stepChanges, repaired },
    );
    report.recovered.push({ runId, missionId: run.missionId, outcome, retryable, reason, stepsChanged: stepChanges.length, repaired });
  }

  /**
   * Bring the legacy run, its agent rows and the mission in line with a settled
   * state. The legacy repositories only move forward, so a row that is already
   * terminal is left as it is; a disagreement there is reported.
   */
  private async alignLegacy(run: MissionRun, plan: MissionPlan, state: MadreRunState, outcome: RecoveryOutcome, reason: string, report: RecoveryReport): Promise<void> {
    const at = this.d.clock.now();
    const mirror = new RepositoryMirror(this.d.agents, this.d.repositories.agents, this.d.clock);
    const success = outcome === 'completed';

    if (run.status === 'completed' || run.status === 'failed') {
      const agrees = (run.status === 'completed') === success;
      if (!agrees) {
        report.conflicts.push({
          runId: run.id,
          missionId: run.missionId,
          detail: `El registro de la ejecución dice «${run.status}» y el estado guardado dice «${state.phase}». Un registro cerrado no se reabre; el estado guardado manda.`,
        });
      }
    }
    // Agent rows: mirror what the steps say, then close whatever is still open.
    await mirror.attach(run.id);
    try {
      await mirror.sync(plan, state);
    } catch (error) {
      // The agent rows are then closed by `finalize` below, without the per-step
      // detail. Say so instead of letting the difference go unnoticed.
      report.conflicts.push({ runId: run.id, missionId: run.missionId, detail: `Los agentes se cerraron sin el detalle de cada paso: ${error instanceof Error ? error.message : String(error)}` });
    }
    await mirror.finalize(run.id);

    const integrate = plan.steps.find((s) => s.kind === 'integrate');
    const integrateState = integrate !== undefined ? state.steps.find((s) => s.stepId === integrate.id) : undefined;
    const finalResult = success && integrateState?.status === 'DONE' ? (integrateState.result?.text ?? null) : null;

    const fresh = await this.d.repositories.runs.findById(run.id);
    if (fresh !== null && (fresh.status === 'pending' || fresh.status === 'running')) {
      if (fresh.status === 'pending' && success) await this.d.repositories.runs.markStarted(run.id, at);
      await this.d.repositories.runs.markFinished(run.id, success ? 'completed' : 'failed', at, {
        finalResult,
        error: success ? null : reason,
      });
    }

    // The mission mirrors its newest run and no other.
    const latest = await this.d.repositories.runs.latestAttempt(run.missionId);
    if (latest === run.attempt) {
      if (success) await this.d.repositories.missions.setFinalResult(run.missionId, finalResult, 'completed', at);
      else await this.d.repositories.missions.updateStatus(run.missionId, 'failed', at);
    }
  }

  /** A run with no MADRE state: only the legacy tables know it. */
  private async recoverWithoutState(run: MissionRun, report: RecoveryReport): Promise<void> {
    if (run.status === 'completed' || run.status === 'failed') return;
    const at = this.d.clock.now();
    const reason = 'El servidor se reinició mientras esta ejecución estaba en curso, antes de guardar su plan.';
    const agents: AgentExecutionRepository = this.d.repositories.agents;
    for (const agent of (await agents.listByRun(run.id)).filter((a) => a.status === 'running')) {
      await agents.markFailed(agent.id, 'El servidor se reinició mientras este agente estaba en ejecución.', at);
    }
    await agents.markRemainingSkipped(run.id, at);
    await this.d.repositories.runs.markFinished(run.id, 'failed', at, { error: reason });
    if ((await this.d.repositories.runs.latestAttempt(run.missionId)) === run.attempt) {
      await this.d.repositories.missions.updateStatus(run.missionId, 'failed', at);
    }
    await this.d.audit.recordOnce(
      `recovery-${run.id}`,
      'engine',
      'run.recovered',
      `Recuperada al arrancar: ${reason}`,
      { missionId: run.missionId, runId: run.id },
      { outcome: 'interrupted', retryable: true, steps: [], repaired: ['registro heredado'] },
    );
    report.recovered.push({ runId: run.id, missionId: run.missionId, outcome: 'interrupted', retryable: true, reason, stepsChanged: 0, repaired: ['registro heredado'] });
  }

  /**
   * A mission that says `running` while none of its runs is: nothing will ever
   * move it. Point it at what its newest run says.
   */
  private async reconcileMissions(report: RecoveryReport): Promise<void> {
    const running = await this.d.repositories.missions.list({ status: 'running', limit: 500 });
    const at = this.d.clock.now();
    for (const { mission } of running) {
      const active = await this.d.repositories.runs.findActiveByMission(mission.id);
      if (active !== null) {
        // A live run behind it. Fine, unless it is paused-for-approval, which is also live.
        continue;
      }
      const runs = await this.d.repositories.runs.listByMission(mission.id);
      const newest = [...runs].sort((a, b) => b.attempt - a.attempt)[0];
      if (newest?.status === 'completed') {
        await this.d.repositories.missions.setFinalResult(mission.id, mission.finalResult, 'completed', at);
      } else {
        await this.d.repositories.missions.updateStatus(mission.id, 'failed', at);
      }
      report.missionsReconciled.push(mission.id);
      await this.d.audit.recordOnce(
        `recovery-mission-${mission.id}`,
        'engine',
        'mission.reconciled',
        'La misión figuraba en ejecución sin ninguna ejecución activa; su estado se ha alineado con su última ejecución.',
        { missionId: mission.id },
        { newestRun: newest?.id ?? null, newestStatus: newest?.status ?? null },
      );
    }
  }
}

/** For callers that only need to know whether a step is one recovery would touch. */
export function isUnsettled(step: Pick<StepState, 'status'>): boolean {
  return !SETTLED.has(step.status);
}
