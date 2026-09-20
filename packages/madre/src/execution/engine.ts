/**
 * The execution engine.
 *
 * Runs a `MissionPlan` to a result. It schedules steps as a dependency graph
 * (sequentially or in parallel), routes each step, runs its tools, calls the
 * model, retries and heals within fixed bounds, pauses for human approval,
 * reviews the work with the independent judge and revises within fixed bounds,
 * records cost, memory and an audit trail, and keeps the legacy
 * `mission_agents` rows in step.
 *
 * Guarantees, each covered by a test:
 *  - Nothing loops forever: attempts per step, revision rounds and healing
 *    switches are all capped.
 *  - `runStep` never rejects, so one step cannot take the scheduler down.
 *  - A failed or blocked step never silently disappears: it is on the run
 *    state, in the blockers, in the QA verdict and in the final brief.
 *  - A paused run stores everything needed to resume, and resuming is safe to
 *    repeat.
 *  - Cancelling stops running work promptly and marks the rest CANCELLED.
 */

import {
  ProviderError,
  ProviderTimeoutError,
  systemClock,
  type Clock,
  type Repositories,
} from '@acc/domain';

import type { AuditLog } from '../audit.ts';
import type { CostController } from '../cost/controller.ts';
import type { Planner } from '../compiler/planner.ts';
import type { MemoryService } from '../memory/service.ts';
import type { ApprovalService } from '../permissions/approvals.ts';
import type { Judge, JudgeSubject } from '../qa/judge.ts';
import type { AgentRegistry } from '../registry/agents.ts';
import type { ProviderCatalog } from '../registry/providers.ts';
import type { ToolRegistry } from '../registry/tools.ts';
import type { SmartRouter } from '../router/router.ts';
import { computePriorities } from '../router/router.ts';
import { KINDS, type MadreStore } from '../store.ts';
import type { ToolPipeline } from '../tools/pipeline.ts';
import type {
  ApprovalRequest,
  ExecutionResult,
  MadreRunState,
  RunMode,
  MissionPlan,
  MissionStep,
  QAResult,
  QAVerdict,
  RoutingDecision,
  StepState,
  StepStatus,
  ToolResult,
} from '../types.ts';
import { errorDetail, sleep as defaultSleep } from '../util.ts';
import {
  BadOutputError,
  CancelledError,
  DEFAULT_HEALING,
  FAILURE_CLASS_LABEL,
  HEALING_ACTION_LABEL,
  assertUsableOutput,
  diagnose,
  type FailureClass,
  type HealingOptions,
} from './healing.ts';
import type { LegacyMirror } from './mirror.ts';
import { AUDITED_EXCLUSIONS, PROVIDER_EVENTS, blockedErrorInfo, explanationData, providerErrorInfo } from './provider-events.ts';
import type { FailedUpstream, StepRunInput, StepRunner, UpstreamText } from './runner.ts';
import { deriveBlockers, deriveConfidence, deriveNextAction, latestVerdict } from './summary.ts';
import { emptyCostSummary } from '../cost/controller.ts';

export interface EngineOptions {
  /** Steps that may run at once. 1 = strictly sequential. */
  parallelism: number;
  /** Times the judge may send work back before the engine moves on. */
  maxRevisionRounds: number;
  agentTimeoutMs: number;
  healing: HealingOptions;
}

export const DEFAULT_ENGINE_OPTIONS: EngineOptions = {
  parallelism: 2,
  maxRevisionRounds: 2,
  agentTimeoutMs: 60_000,
  healing: DEFAULT_HEALING,
};

export interface EngineDeps {
  repositories: Pick<Repositories, 'missions' | 'runs' | 'agents'>;
  store: MadreStore;
  audit: AuditLog;
  approvals: ApprovalService;
  memory: MemoryService;
  cost: CostController;
  router: SmartRouter;
  agents: AgentRegistry;
  tools: ToolRegistry;
  providers: ProviderCatalog;
  judge: Judge;
  runner: StepRunner;
  /** The only way a step reaches a tool: see `tools/pipeline.ts`. */
  toolPipeline: ToolPipeline;
  planner: Planner;
  /** Plans the fixed eight-agent pipeline. Required only to run classic missions. */
  classicPlanner?: Planner | undefined;
  mirror?: LegacyMirror | undefined;
  clock?: Clock;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  options?: Partial<EngineOptions>;
}

export interface EngineOutcome {
  runId: string;
  status: 'completed' | 'failed' | 'paused' | 'cancelled';
  phase: MadreRunState['phase'];
  finalResult: string | null;
  verdict: QAVerdict | null;
}

interface RunContext {
  runId: string;
  missionId: string;
  prompt: string;
  plan: MissionPlan;
  state: MadreRunState;
  approvals: ApprovalRequest[];
  controller: AbortController;
  avoid: Map<string, Set<string>>;
  priorities: Map<string, number>;
  reviewSummary: string | null;
  saving: Promise<void>;
  /** First failure to persist the state. Surfaced by `flush`, never swallowed. */
  saveError: unknown;
  /** Classic runs stay on the provider the mission was started with. */
  pin: { providerId: string; model: string } | null;
  /** Providers already reported as unconfigured in this run, so it is said once. */
  announcedUnconfigured: Set<string>;
}

/** What a step must say when it worked without live sources. */
const LIVE_SOURCES_CAVEAT =
  'No había fuentes en vivo disponibles para este paso, así que las cifras proceden del conocimiento del modelo y no están verificadas.';

/**
 * Failures that say something about the provider, and so count against its
 * circuit breaker. A model that answered with unusable text, a request that was
 * malformed, a budget refusal and a cancellation are not the provider being
 * down, and must not take it out of rotation.
 */
const PROVIDER_FAULTS: ReadonlySet<FailureClass> = new Set<FailureClass>(['timeout', 'rate_limit', 'provider_unavailable', 'auth', 'unknown']);

const BACKGROUND_STATES: ReadonlySet<StepStatus> = new Set(['DONE', 'FAILED', 'BLOCKED', 'CANCELLED']);

/** Spanish agreement: "1 paso" / "3 pasos". Never "1 paso(s)". */
function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export class MadreEngine {
  private readonly d: EngineDeps;
  private readonly clock: Clock;
  private readonly options: EngineOptions;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly active = new Map<string, RunContext>();

  constructor(deps: EngineDeps) {
    this.d = deps;
    this.clock = deps.clock ?? systemClock;
    this.options = { ...DEFAULT_ENGINE_OPTIONS, ...deps.options, healing: { ...DEFAULT_HEALING, ...deps.options?.healing } };
    this.sleep = deps.sleep ?? defaultSleep;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** Whether this process is currently driving the run. */
  isActive(runId: string): boolean {
    return this.active.has(runId);
  }

  async execute(input: { runId: string; resume?: boolean; mode?: RunMode }): Promise<EngineOutcome> {
    const existing = this.active.get(input.runId);
    if (existing !== undefined) {
      return { runId: input.runId, status: 'paused', phase: existing.state.phase, finalResult: null, verdict: null };
    }

    // A run the database already closed is never executed again, whatever the
    // job says: a stale or duplicated job must not reopen it.
    const legacy = await this.d.repositories.runs.findById(input.runId);
    if (legacy !== null && (legacy.status === 'completed' || legacy.status === 'failed')) {
      const known = await this.d.store.get<MadreRunState>(KINDS.runState, input.runId);
      if (known === null || !['completed', 'failed', 'cancelled'].includes(known.phase)) {
        await this.d.audit.record('engine', 'run.refused', `Se ignoró un trabajo para una ejecución ya cerrada como «${legacy.status}».`, { missionId: legacy.missionId, runId: input.runId });
        return { runId: input.runId, status: 'failed', phase: known?.phase ?? 'failed', finalResult: null, verdict: null };
      }
    }

    const ctx = await this.load(input.runId, input.mode);
    this.active.set(input.runId, ctx);
    try {
      const terminal = terminalOutcome(ctx);
      if (terminal !== null) return terminal;

      await this.startLegacy(ctx);
      ctx.state.phase = 'executing';
      ctx.state.startedAt ??= this.now();
      await this.d.audit.record('engine', input.resume === true ? 'run.resumed' : 'run.started', `${input.resume === true ? 'Ejecución reanudada' : 'Ejecución iniciada'} con ${ctx.plan.steps.length} pasos.`, this.ids(ctx));

      await this.resolveWaiting(ctx);
      await this.loop(ctx);
      return await this.conclude(ctx);
    } catch (error) {
      // Infrastructure failure: close the run honestly rather than leave it running.
      return await this.abort(ctx, error);
    } finally {
      await ctx.saving.catch(() => undefined);
      this.active.delete(input.runId);
    }
  }

  /**
   * Stop a run: one executing here, one paused for a person, or one still
   * waiting in the queue. Returns false only when the run does not exist or is
   * already over.
   */
  async cancel(runId: string): Promise<boolean> {
    const ctx = this.active.get(runId);
    if (ctx !== undefined) {
      ctx.state.cancelRequested = true;
      ctx.controller.abort(new CancelledError());
      await this.d.audit.record('user', 'run.cancel_requested', 'Cancelación solicitada.', this.ids(ctx));
      return true;
    }

    // Queued and never started: there is no state to cancel, only the database
    // rows. Close them here; a job that arrives later finds a closed run and is refused.
    const stored = await this.d.store.get<MadreRunState>(KINDS.runState, runId);
    if (stored === null) return this.cancelUnstarted(runId);

    // A run that does not exist, or is already over, has nothing to cancel. Any
    // other failure to load it is a real error and propagates: answering
    // "false" would tell the user their run was not cancellable when in fact
    // the system could not even read it.
    if ((await this.d.repositories.runs.findById(runId)) === null) return false;
    const loaded = await this.load(runId);
    if (['completed', 'failed', 'cancelled'].includes(loaded.state.phase)) return false;
    loaded.state.cancelRequested = true;
    this.active.set(runId, loaded);
    try {
      await this.cancelRemaining(loaded);
      await this.conclude(loaded);
    } finally {
      this.active.delete(runId);
    }
    return true;
  }

  private async cancelUnstarted(runId: string): Promise<boolean> {
    const run = await this.d.repositories.runs.findById(runId);
    if (run === null || run.status === 'completed' || run.status === 'failed') return false;
    const at = this.clock.now();
    await this.d.mirror?.attach(runId);
    await this.d.mirror?.finalize(runId);
    await this.d.repositories.runs.markFinished(runId, 'failed', at, { error: 'La ejecución fue cancelada antes de empezar.' });
    if ((await this.d.repositories.runs.latestAttempt(run.missionId)) === run.attempt) {
      await this.d.repositories.missions.updateStatus(run.missionId, 'failed', at);
    }
    await this.d.audit.record('user', 'run.cancelled', 'La ejecución fue cancelada antes de empezar.', { missionId: run.missionId, runId });
    return true;
  }

  // -------------------------------------------------------------------------
  // Loading and state
  // -------------------------------------------------------------------------

  private async load(runId: string, requestedMode?: RunMode): Promise<RunContext> {
    const run = await this.d.repositories.runs.findById(runId);
    if (run === null) throw new Error(`La ejecución ${runId} no existe.`);
    const mission = await this.d.repositories.missions.findById(run.missionId);
    if (mission === null) throw new Error(`La misión ${run.missionId} no existe.`);

    let plan = await this.d.store.get<MissionPlan>(KINDS.plan, runId);
    let state = await this.d.store.get<MadreRunState>(KINDS.runState, runId);

    if (plan === null || state === null) {
      const mode: RunMode = requestedMode ?? 'madre';
      if (mode === 'classic' && this.d.classicPlanner === undefined) {
        throw new Error('Esta instalación no puede ejecutar misiones clásicas: falta el planificador clásico.');
      }
      const planner = mode === 'classic' ? this.d.classicPlanner! : this.d.planner;
      plan = planner.plan(mission.prompt, { missionId: mission.id, clock: this.clock });
      await this.d.store.put(KINDS.plan, runId, plan, { missionId: mission.id, runId });
      state = this.initialState(runId, mission.id, plan, mode);
      await this.d.audit.record(
        'compiler',
        'plan.created',
        `Misión compilada en ${plural(plan.steps.length, 'paso', 'pasos')}, con ${plural(plan.gaps.length, 'carencia detectada', 'carencias detectadas')}.`,
        { missionId: mission.id, runId },
        { mode, planner: plan.planner, kind: plan.compiled.intent.kind, complexity: plan.compiled.intent.complexity, gaps: plan.gaps.map((g) => g.capability) },
      );
    }

    const approvals = await this.d.approvals.forRun(runId);
    const ctx: RunContext = {
      runId,
      missionId: mission.id,
      prompt: mission.prompt,
      plan,
      state,
      approvals,
      controller: new AbortController(),
      avoid: new Map(),
      priorities: computePriorities(plan),
      reviewSummary: null,
      saving: Promise.resolve(),
      saveError: undefined,
      pin: state.mode === 'classic' ? { providerId: run.providerId, model: run.model } : null,
      announcedUnconfigured: new Set(),
    };
    if (state.cancelRequested) ctx.controller.abort(new CancelledError());
    await this.d.mirror?.attach(runId);
    for (const st of state.steps) {
      const step = plan.steps.find((s) => s.id === st.stepId);
      if (step !== undefined) st.executionId = this.d.mirror?.executionIdFor(step.agentId) ?? st.executionId;
    }
    return ctx;
  }

  private initialState(runId: string, missionId: string, plan: MissionPlan, mode: RunMode): MadreRunState {
    const now = this.now();
    return {
      runId,
      missionId,
      planId: plan.id,
      phase: 'planning',
      steps: plan.steps.map((s) => ({
        stepId: s.id,
        status: 'QUEUED',
        attempts: 0,
        revisions: 0,
        startedAt: null,
        completedAt: null,
        routing: null,
        result: null,
        error: null,
        blockedReason: null,
        waitingFor: null,
        executionId: null,
        history: [{ at: now, status: 'QUEUED', note: 'Planificado.' }],
      })),
      qaRounds: [],
      cost: emptyCostSummary(),
      blockers: [],
      nextAction: null,
      confidence: null,
      startedAt: null,
      updatedAt: now,
      completedAt: null,
      cancelRequested: false,
      mode,
    };
  }

  private now(): string {
    return this.clock.now().toISOString();
  }

  private ids(ctx: RunContext, stepId: string | null = null) {
    return { missionId: ctx.missionId, runId: ctx.runId, stepId };
  }

  private stateOf(ctx: RunContext, stepId: string): StepState {
    const st = ctx.state.steps.find((s) => s.stepId === stepId);
    if (st === undefined) throw new Error(`El paso ${stepId} no está en el estado de la ejecución.`);
    return st;
  }

  private setStatus(ctx: RunContext, st: StepState, status: StepStatus, note: string): void {
    st.status = status;
    st.history.push({ at: this.now(), status, note });
    if (status === 'RUNNING' && st.startedAt === null) st.startedAt = this.now();
    if (BACKGROUND_STATES.has(status)) st.completedAt = this.now();
    this.save(ctx);
  }

  /** Queue a write of the state (and the mirror). Writes are serialised. */
  private save(ctx: RunContext): void {
    ctx.saving = ctx.saving
      .then(async () => {
        ctx.state.updatedAt = this.now();
        ctx.state.blockers = deriveBlockers(ctx.plan, ctx.state, ctx.approvals);
        ctx.state.nextAction = deriveNextAction(ctx.plan, ctx.state, ctx.approvals);
        ctx.state.confidence = deriveConfidence(ctx.plan, ctx.state);
        await this.d.store.put(KINDS.runState, ctx.runId, structuredClone(ctx.state), { missionId: ctx.missionId, runId: ctx.runId });
        await this.d.mirror?.sync(ctx.plan, ctx.state);
      })
      .catch((error: unknown) => {
        // Not swallowed: `flush` re-throws it, so a run whose state cannot be
        // persisted stops (and is closed) instead of carrying on unrecorded.
        ctx.saveError ??= error;
      });
  }

  private async flush(ctx: RunContext): Promise<void> {
    this.save(ctx);
    await ctx.saving;
    if (ctx.saveError !== undefined) {
      const error = ctx.saveError;
      ctx.saveError = undefined;
      throw new Error(`No se pudo guardar el estado de la ejecución: ${errorDetail(error)}`);
    }
  }

  private async startLegacy(ctx: RunContext): Promise<void> {
    const run = await this.d.repositories.runs.findById(ctx.runId);
    if (run?.status === 'pending') {
      await this.d.repositories.runs.markStarted(ctx.runId, this.clock.now());
      await this.d.repositories.missions.updateStatus(ctx.missionId, 'running', this.clock.now());
    }
  }

  // -------------------------------------------------------------------------
  // Scheduler
  // -------------------------------------------------------------------------

  private async loop(ctx: RunContext): Promise<void> {
    const running = new Map<string, Promise<void>>();

    for (;;) {
      if (ctx.controller.signal.aborted || ctx.state.cancelRequested) {
        // Let in-flight steps notice the abort and settle, then stop scheduling.
        if (running.size > 0) {
          await Promise.allSettled([...running.values()]);
        }
        await this.cancelRemaining(ctx);
        return;
      }

      this.propagateBlocks(ctx);
      const ready = this.readySteps(ctx).filter((s) => !running.has(s.id));

      // Route the QA/integration steps alone: they judge and revise other steps.
      for (const step of ready) {
        if (running.size >= this.options.parallelism) break;
        if ((step.kind === 'qa' || step.kind === 'integrate') && running.size > 0) continue;
        // `running` is what stops a step being started twice; its status changes
        // once routing has actually decided to run it.
        const promise = this.runStep(ctx, step).finally(() => running.delete(step.id));
        running.set(step.id, promise);
        if (step.kind === 'qa' || step.kind === 'integrate') break;
      }

      if (running.size === 0) return;
      await Promise.race(running.values());
    }
  }

  private readySteps(ctx: RunContext): MissionStep[] {
    return ctx.plan.steps
      .filter((step) => {
        const st = this.stateOf(ctx, step.id);
        if (st.status !== 'QUEUED') return false;
        return step.dependsOn.every((dep) => {
          const depState = this.stateOf(ctx, dep.stepId);
          return dep.mode === 'hard' ? depState.status === 'DONE' : BACKGROUND_STATES.has(depState.status);
        });
      })
      .sort((a, b) => (ctx.priorities.get(a.id) ?? 99) - (ctx.priorities.get(b.id) ?? 99) || a.id.localeCompare(b.id));
  }

  /** A step whose hard dependency ended without a result can never run. */
  private propagateBlocks(ctx: RunContext): void {
    let changed = true;
    while (changed) {
      changed = false;
      for (const step of ctx.plan.steps) {
        const st = this.stateOf(ctx, step.id);
        if (st.status !== 'QUEUED') continue;
        const dead = step.dependsOn.find((dep) => {
          const s = this.stateOf(ctx, dep.stepId).status;
          return dep.mode === 'hard' && (s === 'FAILED' || s === 'BLOCKED' || s === 'CANCELLED');
        });
        if (dead === undefined) continue;
        const depTitle = ctx.plan.steps.find((s) => s.id === dead.stepId)?.title ?? dead.stepId;
        st.blockedReason = `Esperaba a «${depTitle}», que no llegó a terminar.`;
        this.setStatus(ctx, st, 'BLOCKED', st.blockedReason);
        void this.d.audit.record('engine', 'step.blocked', st.blockedReason, this.ids(ctx, step.id));
        changed = true;
      }
    }
  }

  private async cancelRemaining(ctx: RunContext): Promise<void> {
    for (const st of ctx.state.steps) {
      if (st.status === 'QUEUED' || st.status === 'WAITING' || st.status === 'RETRYING' || st.status === 'RUNNING') {
        this.setStatus(ctx, st, 'CANCELLED', 'Cancelado por el usuario.');
      }
    }
    // Pending approvals for a cancelled run must not linger in the inbox.
    for (const a of ctx.approvals.filter((x) => x.status === 'pending')) {
      await this.d.approvals.decide(a.id, 'denied', 'La ejecución fue cancelada.').catch(() => undefined);
    }
    ctx.approvals = await this.d.approvals.forRun(ctx.runId);
    await this.flush(ctx);
  }

  // -------------------------------------------------------------------------
  // Approvals
  // -------------------------------------------------------------------------

  private async resolveWaiting(ctx: RunContext): Promise<void> {
    ctx.approvals = await this.d.approvals.forRun(ctx.runId);
    for (const st of ctx.state.steps) {
      if (st.status !== 'WAITING') continue;
      const approval = ctx.approvals.find((a) => a.id === st.waitingFor);
      if (approval === undefined || approval.status === 'pending') continue;
      if (approval.status === 'approved') {
        st.waitingFor = null;
        this.setStatus(ctx, st, 'QUEUED', approval.kind === 'input' ? 'Entrada recibida.' : 'Aprobado.');
        await this.d.audit.record('user', 'approval.approved', `Aprobado: ${approval.title}`, this.ids(ctx, st.stepId));
      } else {
        st.waitingFor = null;
        st.blockedReason = approval.kind === 'input' ? 'El usuario no aportó la entrada solicitada.' : 'El usuario denegó esta acción.';
        this.setStatus(ctx, st, 'BLOCKED', st.blockedReason);
        await this.d.audit.record('user', 'approval.denied', `Denegado: ${approval.title}`, this.ids(ctx, st.stepId));
      }
    }
  }

  private async requestApproval(
    ctx: RunContext,
    step: MissionStep,
    st: StepState,
    kind: 'permission' | 'input',
    title: string,
    detail: string,
  ): Promise<void> {
    const approval = await this.d.approvals.request({
      missionId: ctx.missionId,
      runId: ctx.runId,
      stepId: step.id,
      kind,
      level: kind === 'permission' ? 'EXTERNAL_ACTION' : null,
      title,
      detail,
    });
    ctx.approvals = [...ctx.approvals, approval];
    st.waitingFor = approval.id;
    this.setStatus(ctx, st, 'WAITING', detail);
    await this.d.audit.record('policy', 'approval.requested', title, this.ids(ctx, step.id), { approvalId: approval.id, kind });
  }

  // -------------------------------------------------------------------------
  // Steps
  // -------------------------------------------------------------------------

  /** Never rejects. */
  private async runStep(ctx: RunContext, step: MissionStep): Promise<void> {
    const st = this.stateOf(ctx, step.id);
    try {
      if (step.kind === 'input') return await this.runInput(ctx, step, st);
      ctx.state.phase = step.kind === 'agent' ? 'executing' : 'reviewing';

      if (step.kind === 'qa') return await this.runQa(ctx, step, st);
      if (step.kind === 'integrate') return await this.runIntegrate(ctx, step, st);

      const ok = await this.prepareAndRun(ctx, step, st, null);
      void ok;
    } catch (error) {
      st.error = errorDetail(error);
      this.setStatus(ctx, st, 'FAILED', `Error inesperado: ${st.error}`);
      await this.d.audit.record('engine', 'step.error', `Error inesperado en «${step.title}»: ${st.error}`, this.ids(ctx, step.id));
    }
  }

  private async runInput(ctx: RunContext, step: MissionStep, st: StepState): Promise<void> {
    const approval = ctx.approvals.find((a) => a.stepId === step.id && a.kind === 'input');
    if (approval === undefined) {
      await this.requestApproval(ctx, step, st, 'input', 'Aporta la información solicitada', step.task.instruction);
      return;
    }
    if (approval.status === 'approved') {
      const text = approval.note ?? '';
      st.result = {
        stepId: step.id, agentId: 'user', status: 'DONE', text, provider: null, model: null, requestId: null,
        promptTokens: 0, completionTokens: 0, costUsd: 0, latencyMs: 0, attempts: 1, toolResults: [], caveats: [], error: null,
      };
      this.setStatus(ctx, st, 'DONE', 'Entrada aportada por el usuario.');
      return;
    }
    if (approval.status === 'denied') {
      st.blockedReason = 'El usuario no aportó la entrada solicitada.';
      this.setStatus(ctx, st, 'BLOCKED', st.blockedReason);
      return;
    }
    this.setStatus(ctx, st, 'WAITING', step.task.instruction);
  }

  /**
   * Route, gate on approval, run tools, then call the model with bounded
   * retries. Returns true when the step ended DONE. On a revision, a failure
   * puts the earlier result back instead of losing it.
   */
  private async prepareAndRun(
    ctx: RunContext,
    step: MissionStep,
    st: StepState,
    revision: { instruction: string; previousText: string } | null,
    extra: { reviewSummary?: string | null } = {},
  ): Promise<boolean> {
    const previous = st.result;
    const restore = (why: string): boolean => {
      if (previous === null) return false;
      st.result = previous;
      st.error = null;
      this.setStatus(ctx, st, 'DONE', `${why} Se conservó la versión anterior.`);
      return false;
    };

    const decision = await this.d.router.route(step, {
      missionId: ctx.missionId,
      avoidProviders: [...(ctx.avoid.get(step.id) ?? [])],
      priority: ctx.priorities.get(step.id) ?? 1,
      ...(ctx.pin !== null ? { pin: ctx.pin } : {}),
    });
    st.routing = decision;
    await this.d.audit.record(
      'router',
      'route.decided',
      decision.blocked !== null
        ? `No se pudo enrutar «${step.title}»: ${decision.blocked.reason}`
        : `«${step.title}» enrutado a ${decision.provider?.id}/${decision.provider?.model} (${decision.execution}).`,
      this.ids(ctx, step.id),
      { provider: decision.provider, execution: decision.execution, confidence: decision.confidence, priority: decision.priority },
    );
    await this.auditRouting(ctx, step, decision);

    if (decision.blocked !== null) {
      if (decision.blocked.code !== undefined) {
        st.providerError = blockedErrorInfo(decision.blocked.code, decision.blocked.reason, ctx.pin?.providerId ?? null);
      }
      if (previous !== null) return restore(`No se pudo reenrutar: ${decision.blocked.reason}`);
      st.blockedReason = decision.blocked.reason;
      this.setStatus(ctx, st, 'BLOCKED', decision.blocked.reason);
      return false;
    }

    const approved = ctx.approvals.some((a) => a.stepId === step.id && a.kind === 'permission' && a.status === 'approved');
    if (decision.requiresApproval && !approved && revision === null) {
      await this.requestApproval(ctx, step, st, 'permission', `Aprobar «${step.title}»`, decision.approvalReasons.join(' '));
      return false;
    }

    const { toolResults, caveats } = await this.runTools(ctx, step, st, approved);

    // A tool the step cannot do without, and could not get, stops the step with
    // the reason — it does not go on to ask a model to improvise the missing input.
    const missing = toolResults.find((result, index) => !result.ok && step.toolRequests[index]?.required === true);
    if (missing !== undefined) {
      const reason = `La herramienta obligatoria «${missing.toolId}» no se pudo usar: ${missing.error ?? 'sin detalle'}`;
      if (previous !== null) return restore(reason);
      st.blockedReason = reason;
      this.setStatus(ctx, st, 'BLOCKED', reason);
      return false;
    }
    return await this.attempts(ctx, step, st, decision, toolResults, caveats, revision, extra.reviewSummary ?? null, restore);
  }

  /**
   * Run every tool the step asked for through the tool pipeline. Each request
   * yields exactly one result, in order — executed or refused with a reason.
   * Nothing is dropped: a refusal is on the result, in the audit log and, via
   * `StepState.toolResults`, in the trace.
   */
  private async runTools(ctx: RunContext, step: MissionStep, st: StepState, approved: boolean) {
    const toolResults: ToolResult[] = [];
    const caveats: string[] = [];
    for (const request of step.toolRequests) {
      const result = await this.d.toolPipeline.run({
        request,
        missionId: ctx.missionId,
        runId: ctx.runId,
        stepId: step.id,
        agentId: step.agentId,
        approved,
        signal: ctx.controller.signal,
      });
      toolResults.push(result);
      if (!result.ok && (request.toolId === 'web.search' || request.toolId === 'web.fetch')) caveats.push(LIVE_SOURCES_CAVEAT);
    }
    st.toolResults = toolResults;
    this.save(ctx);
    const searched = toolResults.some((r) => r.toolId === 'web.search' && r.ok);
    if (step.task.needsFreshInformation && !searched && caveats.length === 0) caveats.push(LIVE_SOURCES_CAVEAT);
    return { toolResults, caveats: [...new Set(caveats)] };
  }

  private async attempts(
    ctx: RunContext,
    step: MissionStep,
    st: StepState,
    initial: RoutingDecision,
    toolResults: ToolResult[],
    caveats: string[],
    revision: { instruction: string; previousText: string } | null,
    reviewSummary: string | null,
    restore: (why: string) => boolean,
  ): Promise<boolean> {
    const agent = this.d.agents.require(step.agentId);
    const max = Math.max(1, step.maxAttempts);
    let decision = initial;
    let correction: string | null = null;
    let attempt = 0;

    for (;;) {
      attempt += 1;
      st.attempts += 1;
      this.setStatus(ctx, st, 'RUNNING', attempt === 1 ? (revision !== null ? 'Revisando.' : 'Iniciado.') : `Intento ${attempt}.`);

      // A real (referenced) timer rather than AbortSignal.timeout, whose timer is
      // unreferenced and would not keep a quiet process alive long enough to fire.
      const timeoutController = new AbortController();
      const timer = setTimeout(() => timeoutController.abort(), this.options.agentTimeoutMs);
      const timeout = timeoutController.signal;
      const signal = AbortSignal.any([ctx.controller.signal, timeout]);
      const provider = decision.provider!;
      await this.d.audit.record(
        'engine',
        PROVIDER_EVENTS.requestStarted,
        `Llamada a ${provider.id}/${provider.model} para «${step.title}» (intento ${attempt}).`,
        this.ids(ctx, step.id),
        { provider: provider.id, model: provider.model, attempt, execution: decision.execution, tier: provider.tier },
      );

      try {
        const out = await this.d.runner.run(
          {
            missionId: ctx.missionId,
            runId: ctx.runId,
            missionPrompt: ctx.prompt,
            step,
            agent,
            provider: { id: provider.id, model: provider.model },
            ...this.upstreamFor(ctx, step),
            toolResults,
            caveats,
            plan: {
              objective: ctx.plan.compiled.objective.text,
              constraints: ctx.plan.compiled.constraints.map((c) => c.text),
              openQuestions: ctx.plan.compiled.openQuestions,
              deliverableTitle: ctx.plan.compiled.expectedDeliverable.title,
              deliverableSections: ctx.plan.compiled.expectedDeliverable.sections,
            },
            revision,
            correction,
            reviewSummary: reviewSummary ?? ctx.reviewSummary,
            attempt,
          },
          signal,
        );
        clearTimeout(timer);

        // The call happened and the tokens were spent, whatever the engine then
        // thinks of the text. Record the cost before judging the output, so an
        // unusable answer is not a free one.
        const estimated = this.d.cost.estimate(out.provider, out.model, out.promptTokens, out.completionTokens);
        await this.d.cost.record({
          missionId: ctx.missionId,
          runId: ctx.runId,
          stepId: step.id,
          agentId: step.agentId,
          provider: out.provider,
          model: out.model,
          promptTokens: out.promptTokens,
          completionTokens: out.completionTokens,
          latencyMs: out.latencyMs,
          source: out.source,
          requestId: out.requestId,
        });
        ctx.state.cost = await this.d.cost.summary({ runId: ctx.runId });
        await this.d.audit.record(
          'engine',
          PROVIDER_EVENTS.requestSucceeded,
          `${out.provider}/${out.model} respondió a «${step.title}» en ${out.latencyMs} ms (${out.source === 'real' ? 'real' : 'simulado'}).`,
          this.ids(ctx, step.id),
          {
            provider: out.provider, model: out.model, attempt, requestId: out.requestId, latencyMs: out.latencyMs,
            promptTokens: out.promptTokens, completionTokens: out.completionTokens, source: out.source, simulated: out.simulated,
          },
        );
        await this.d.audit.record(
          'cost',
          PROVIDER_EVENTS.costRecorded,
          estimated === null
            ? `Llamada a ${out.provider}/${out.model} sin precio conocido: se registra sin coste, no como 0 USD.`
            : `Llamada a ${out.provider}/${out.model}: ${estimated} USD.`,
          this.ids(ctx, step.id),
          {
            provider: out.provider, model: out.model, promptTokens: out.promptTokens, completionTokens: out.completionTokens,
            costUsd: estimated, priced: estimated !== null, source: out.source, simulated: out.simulated, requestId: out.requestId,
          },
        );
        assertUsableOutput(out.text);
        await this.reportProviderSuccess(ctx, step, out.provider);

        const result: ExecutionResult = {
          stepId: step.id,
          agentId: step.agentId,
          status: 'DONE',
          text: out.text,
          provider: out.provider,
          model: out.model,
          requestId: out.requestId,
          promptTokens: out.promptTokens,
          completionTokens: out.completionTokens,
          costUsd: estimated,
          latencyMs: out.latencyMs,
          source: out.source,
          simulated: out.simulated,
          attempts: attempt,
          toolResults,
          caveats,
          error: null,
        };
        st.result = result;
        st.error = null;
        st.providerError = null;
        this.setStatus(ctx, st, 'DONE', revision !== null ? 'Revisado.' : 'Completado.');
        await this.d.audit.record('engine', 'step.completed', `«${step.title}» completado con ${out.provider}/${out.model} en ${out.latencyMs} ms.`, this.ids(ctx, step.id));
        return true;
      } catch (raw) {
        clearTimeout(timer);
        if (ctx.controller.signal.aborted) {
          st.error = null;
          await this.d.audit.record(
            'engine',
            PROVIDER_EVENTS.requestFailed,
            `La llamada a ${provider.id}/${provider.model} para «${step.title}» se canceló.`,
            this.ids(ctx, step.id),
            { provider: provider.id, model: provider.model, attempt, code: 'PROVIDER_CANCELLED', stage: 'request', retryable: false },
          );
          this.setStatus(ctx, st, 'CANCELLED', 'Cancelado por el usuario.');
          return false;
        }
        const error = timeout.aborted && !(raw instanceof BadOutputError) ? new ProviderTimeoutError(provider.id, this.options.agentTimeoutMs) : raw;
        const diagnosis = diagnose(error, attempt, this.options.healing);
        await this.d.audit.record(
          'engine',
          'step.attempt_failed',
          `El intento ${attempt} de «${step.title}» falló (${FAILURE_CLASS_LABEL[diagnosis.class]}): ${diagnosis.explanation}`,
          this.ids(ctx, step.id),
          { class: diagnosis.class, action: diagnosis.action, provider: provider.id },
        );

        const info = providerErrorInfo(error, diagnosis, provider.id, provider.model);
        st.providerError = info;
        await this.d.audit.record(
          'engine',
          PROVIDER_EVENTS.requestFailed,
          `${provider.id}/${provider.model} falló en «${step.title}» (${info.code}): ${info.message}`,
          this.ids(ctx, step.id),
          { attempt, ...info, class: diagnosis.class, action: diagnosis.action },
        );

        // The circuit breaker hears about every failure that is the provider's
        // doing — before this step decides what to do next, so the very next
        // routing decision already sees an open circuit.
        //
        // A structured error says for itself whether it counts. A permanent
        // configuration error (a rejected key, no quota) does not: waiting out a
        // cooldown would not fix it and the breaker would reopen the provider to
        // the same rejection, so the provider is taken out of service instead.
        if (error instanceof ProviderError) {
          if (error.countsAgainstCircuit) await this.reportProviderFailure(ctx, step, provider.id, error.providerCode);
          else if (error.permanent) await this.takeOutOfService(ctx, step, provider.id, error);
        } else if (PROVIDER_FAULTS.has(diagnosis.class)) {
          await this.reportProviderFailure(ctx, step, provider.id, diagnosis.class);
        }

        // A retry must not go back to a provider the router would now refuse: if
        // this failure opened its circuit, the step is routed again instead of
        // sending one more request to a provider that is out of rotation.
        const circuitOpened = this.d.router.circuitState(provider.id)?.open === true;
        const reroute = diagnosis.switchProvider || circuitOpened;

        if (diagnosis.switchProvider) {
          const set = ctx.avoid.get(step.id) ?? new Set<string>();
          set.add(provider.id);
          ctx.avoid.set(step.id, set);
        }

        if (!diagnosis.retryable || attempt >= max) {
          st.error = diagnosis.explanation;
          await this.d.memory.recordLesson({
            title: `«${step.title}» falló (${FAILURE_CLASS_LABEL[diagnosis.class]})`,
            content: `${diagnosis.explanation} Proveedor: ${provider.id}/${provider.model}. Intentos: ${attempt}.`,
            missionId: ctx.missionId,
            runId: ctx.runId,
            tags: [diagnosis.class, step.agentId],
          });
          if (revision !== null) return restore(`La revisión falló (${FAILURE_CLASS_LABEL[diagnosis.class]}).`);
          this.setStatus(ctx, st, 'FAILED', `${FAILURE_CLASS_LABEL[diagnosis.class]}: ${diagnosis.explanation}`);
          return false;
        }

        this.setStatus(ctx, st, 'RETRYING', `${FAILURE_CLASS_LABEL[diagnosis.class]}: ${diagnosis.explanation}. Se va a ${HEALING_ACTION_LABEL[diagnosis.action]}.`);
        correction =
          diagnosis.action === 'retry_with_correction'
            ? 'Tu respuesta anterior estaba vacía o no era utilizable. Responde a la tarea de forma directa y completa, en español.'
            : null;

        if (reroute) {
          decision = await this.d.router.route(step, {
            missionId: ctx.missionId,
            avoidProviders: [...(ctx.avoid.get(step.id) ?? [])],
            priority: ctx.priorities.get(step.id) ?? 1,
            ...(ctx.pin !== null ? { pin: ctx.pin } : {}),
          });
          st.routing = decision;
          if (decision.blocked !== null || decision.provider === null) {
            st.error = decision.blocked?.reason ?? 'No hay otro proveedor disponible.';
            await this.auditRouting(ctx, step, decision);
            if (revision !== null) return restore(`Sin otro proveedor: ${st.error}`);
            this.setStatus(ctx, st, 'FAILED', `Ningún otro proveedor pudo hacerse cargo: ${st.error}`);
            return false;
          }
          await this.d.audit.record('router', 'route.switched', `«${step.title}» cambiado a ${decision.provider.id}/${decision.provider.model}.`, this.ids(ctx, step.id));
          await this.auditRouting(ctx, step, decision);
        }

        try {
          await this.sleep(diagnosis.backoffMs, ctx.controller.signal);
        } catch {
          this.setStatus(ctx, st, 'CANCELLED', 'Cancelado por el usuario.');
          return false;
        }
      }
    }
  }

  // ---- provider events --------------------------------------------------------

  /**
   * Say, in the audit log, what the router decided and who it turned away.
   * `provider.selected` carries the whole explanation; a real provider that was
   * kept out gets its own `provider.excluded` line, and one with no key or model
   * is reported once per run as `provider.unconfigured`. The simulation is never
   * reported as excluded: it is the last resort by design, not a failure.
   */
  private async auditRouting(ctx: RunContext, step: MissionStep, decision: RoutingDecision): Promise<void> {
    await this.auditCircuitTransitions(ctx, step);
    const explanation = decision.explanation;
    if (explanation === undefined) return;
    const ids = this.ids(ctx, step.id);

    if (decision.provider !== null) {
      const source = decision.provider.tier === 'mock' ? 'mock' : 'real';
      await this.d.audit.record(
        'router',
        PROVIDER_EVENTS.selected,
        `«${step.title}»: ${decision.provider.id}/${decision.provider.model} (${source === 'real' ? 'real' : 'simulado'}), entre ${plural(explanation.candidates.length, 'candidato', 'candidatos')} y ${plural(explanation.excludedCandidates.length, 'descartado', 'descartados')}.`,
        ids,
        { ...explanationData(explanation), source, execution: decision.execution },
      );
    }
    for (const excluded of explanation.excludedCandidates) {
      if (excluded.providerId === 'mock') continue;
      if (excluded.code === 'unconfigured') {
        if (ctx.announcedUnconfigured.has(excluded.providerId)) continue;
        ctx.announcedUnconfigured.add(excluded.providerId);
        await this.d.audit.record('router', PROVIDER_EVENTS.unconfigured, `${excluded.providerId} no está configurado: ${excluded.reason}`, ids, {
          provider: excluded.providerId, code: 'PROVIDER_UNCONFIGURED',
        });
      } else if (AUDITED_EXCLUSIONS.has(excluded.code)) {
        await this.d.audit.record('router', PROVIDER_EVENTS.excluded, `${excluded.providerId}${excluded.model !== null ? `/${excluded.model}` : ''} queda fuera de «${step.title}»: ${excluded.reason}`, ids, {
          provider: excluded.providerId, model: excluded.model, code: excluded.code, errorCode: excluded.errorCode,
        });
      }
    }
  }

  /** A provider whose cooldown expired is on probation: the next call is its probe. Say so once. */
  private async auditCircuitTransitions(ctx: RunContext, step: MissionStep): Promise<void> {
    for (const providerId of this.d.router.takeCircuitTransitions()) {
      await this.d.audit.record(
        'router',
        PROVIDER_EVENTS.circuitHalfOpen,
        `${providerId} terminó su tiempo fuera de rotación: la siguiente llamada es la de prueba. Si sale bien, vuelve del todo; si falla, queda fuera otra vez.`,
        this.ids(ctx, step.id),
        { providerId },
      );
    }
  }

  /** A configuration error (rejected key, no quota) will not fix itself: stop routing to the provider. */
  private async takeOutOfService(ctx: RunContext, step: MissionStep, providerId: string, error: ProviderError): Promise<void> {
    this.d.router.markProviderUnusable(providerId, error.publicMessage);
    await this.d.audit.record(
      'router',
      PROVIDER_EVENTS.excluded,
      `${providerId} queda fuera de servicio hasta que se corrija la configuración: ${error.publicMessage}`,
      this.ids(ctx, step.id),
      { provider: providerId, code: 'unusable', errorCode: error.providerCode, permanent: true },
    );
  }

  // ---- circuit breaker ------------------------------------------------------

  /** A successful call clears the provider's record; if it was on probation, say it is back. */
  private async reportProviderSuccess(ctx: RunContext, step: MissionStep, providerId: string): Promise<void> {
    const wasOnProbation = this.d.router.circuitState(providerId)?.probation === true;
    this.d.router.recordSuccess(providerId);
    if (wasOnProbation) {
      await this.d.audit.record(
        'router',
        PROVIDER_EVENTS.circuitClosed,
        `${providerId} vuelve a estar en rotación del todo: la llamada de prueba salió bien.`,
        this.ids(ctx, step.id),
        { providerId },
      );
    }
  }

  /** A failed call counts against the provider; at the threshold the circuit opens and routing excludes it. */
  private async reportProviderFailure(ctx: RunContext, step: MissionStep, providerId: string, failureClass: string): Promise<void> {
    const wasOpen = this.d.router.circuitState(providerId)?.open === true;
    const after = this.d.router.recordFailure(providerId);
    if (after.open && !wasOpen) {
      await this.d.audit.record(
        'router',
        PROVIDER_EVENTS.circuitOpened,
        `${providerId} queda fuera de rotación tras ${plural(after.consecutiveFailures, 'fallo seguido', 'fallos seguidos')} (${failureClass}); vuelve a probarse a partir de ${after.openedUntil}.`,
        this.ids(ctx, step.id),
        { providerId, failures: after.consecutiveFailures, openedUntil: after.openedUntil, failureClass },
      );
    }
  }

  private upstreamFor(ctx: RunContext, step: MissionStep): { upstream: UpstreamText[]; failed: FailedUpstream[] } {
    const upstream: UpstreamText[] = [];
    const failed: FailedUpstream[] = [];
    for (const dep of step.dependsOn) {
      const depStep = ctx.plan.steps.find((s) => s.id === dep.stepId);
      const depState = this.stateOf(ctx, dep.stepId);
      if (depStep === undefined) continue;
      const agentName = depStep.kind === 'input' ? 'Usuario' : (this.d.agents.get(depStep.agentId)?.name ?? depStep.agentId);
      if (depState.status === 'DONE' && depState.result !== null) {
        upstream.push({ stepId: depStep.id, title: depStep.title, agentName, text: depState.result.text });
      } else if (depState.status === 'FAILED' || depState.status === 'BLOCKED' || depState.status === 'CANCELLED') {
        failed.push({ stepId: depStep.id, title: depStep.title, agentName, error: depState.error ?? depState.blockedReason ?? depState.status.toLowerCase() });
      }
    }
    return { upstream, failed };
  }

  // -------------------------------------------------------------------------
  // Review and integration
  // -------------------------------------------------------------------------

  private subjects(ctx: RunContext, kinds: readonly MissionStep['kind'][]): JudgeSubject[] {
    return ctx.plan.steps.filter((s) => kinds.includes(s.kind)).map((step) => ({ step, state: this.stateOf(ctx, step.id) }));
  }

  private async judge(ctx: RunContext, stage: 'workers' | 'final', round: number, finalText: string | null): Promise<QAResult> {
    const result = this.d.judge.review({
      plan: ctx.plan,
      stage,
      round,
      subjects: this.subjects(ctx, stage === 'workers' ? ['agent'] : ['agent', 'integrate']),
      finalText,
      now: this.clock.now(),
    });
    ctx.state.qaRounds.push(result);
    await this.d.store.put(KINDS.qa, result.id, result, { missionId: ctx.missionId, runId: ctx.runId });
    await this.d.audit.record('judge', 'qa.verdict', `Revisión ${stage === 'workers' ? 'de los especialistas' : 'del informe final'}, ronda ${round}: ${result.verdict}. ${result.summary}`, this.ids(ctx), {
      verdict: result.verdict,
      issues: result.issues.length,
      revisions: result.revisionRequests.length,
    });
    this.save(ctx);
    return result;
  }

  /**
   * Send flagged steps back. In the final stage only the integrator can be
   * revised: reworking a specialist after the brief was written would leave
   * the brief stale. Returns how many steps were sent back.
   */
  private async revise(ctx: RunContext, result: QAResult, onlyKinds: readonly MissionStep['kind'][]): Promise<number> {
    const targets = result.revisionRequests.filter((r) => {
      const step = ctx.plan.steps.find((s) => s.id === r.stepId);
      return step !== undefined && onlyKinds.includes(step.kind) && this.stateOf(ctx, r.stepId).status === 'DONE';
    });
    for (const request of targets) {
      const step = ctx.plan.steps.find((s) => s.id === request.stepId)!;
      const st = this.stateOf(ctx, step.id);
      if (ctx.controller.signal.aborted) return targets.length;
      st.revisions += 1;
      await this.d.audit.record('judge', 'revision.requested', `«${step.title}» devuelto para revisión: ${request.instruction.slice(0, 200)}`, this.ids(ctx, step.id));
      await this.prepareAndRun(ctx, step, st, { instruction: request.instruction, previousText: st.result?.text ?? '' });
    }
    return targets.length;
  }

  /** Classic runs are one pass: the judge still reports, but nothing is sent back. */
  private revisionRounds(ctx: RunContext): number {
    return ctx.state.mode === 'classic' ? 0 : this.options.maxRevisionRounds;
  }

  private async runQa(ctx: RunContext, step: MissionStep, st: StepState): Promise<void> {
    let round = 0;
    let verdict: QAResult;
    for (;;) {
      round += 1;
      verdict = await this.judge(ctx, 'workers', round, null);
      if (verdict.verdict !== 'NEEDS_REVISION' || round > this.revisionRounds(ctx)) break;
      const sent = await this.revise(ctx, verdict, ['agent']);
      if (ctx.controller.signal.aborted) {
        this.setStatus(ctx, st, 'CANCELLED', 'Cancelado por el usuario.');
        return;
      }
      if (sent === 0) break;
    }

    if (verdict.verdict === 'BLOCKED') {
      st.blockedReason = verdict.summary;
      this.setStatus(ctx, st, 'BLOCKED', `El juez no encontró nada utilizable que revisar. ${verdict.summary}`);
      return;
    }

    ctx.reviewSummary = [
      `Veredicto: ${verdict.verdict}. ${verdict.summary}`,
      ...verdict.issues.filter((i) => i.severity !== 'info').slice(0, 12).map((i) => `- [${i.severity}] ${i.message}`),
    ].join('\n');
    await this.prepareAndRun(ctx, step, st, null, { reviewSummary: ctx.reviewSummary });
  }

  private async runIntegrate(ctx: RunContext, step: MissionStep, st: StepState): Promise<void> {
    const ok = await this.prepareAndRun(ctx, step, st, null);
    if (!ok || st.status !== 'DONE') return;

    let round = 0;
    for (;;) {
      round += 1;
      const verdict = await this.judge(ctx, 'final', round, st.result?.text ?? '');
      if (verdict.verdict !== 'NEEDS_REVISION' || round > this.revisionRounds(ctx)) return;
      const sent = await this.revise(ctx, verdict, ['integrate']);
      if (ctx.controller.signal.aborted || sent === 0) return;
    }
  }

  // -------------------------------------------------------------------------
  // Conclusion
  // -------------------------------------------------------------------------

  private async conclude(ctx: RunContext): Promise<EngineOutcome> {
    ctx.approvals = await this.d.approvals.forRun(ctx.runId);
    const waiting = ctx.state.steps.some((s) => s.status === 'WAITING');
    const cancelled = ctx.state.cancelRequested || ctx.controller.signal.aborted;

    if (cancelled) {
      await this.cancelRemaining(ctx);
      ctx.state.phase = 'cancelled';
      ctx.state.completedAt = this.now();
      await this.flush(ctx);
      await this.closeLegacy(ctx, 'failed', null, 'La ejecución fue cancelada.');
      await this.d.audit.record('engine', 'run.cancelled', 'La ejecución fue cancelada.', this.ids(ctx));
      return { runId: ctx.runId, status: 'cancelled', phase: 'cancelled', finalResult: null, verdict: latestVerdict(ctx.state.qaRounds) };
    }

    if (waiting) {
      ctx.state.phase = 'paused';
      await this.flush(ctx);
      await this.d.audit.record('engine', 'run.paused', 'En pausa: a la espera de que una persona apruebe o aporte información.', this.ids(ctx));
      return { runId: ctx.runId, status: 'paused', phase: 'paused', finalResult: null, verdict: latestVerdict(ctx.state.qaRounds) };
    }

    // Anything still QUEUED can never run now (its dependencies are terminal).
    for (const st of ctx.state.steps) {
      if (st.status === 'QUEUED') {
        st.blockedReason = 'Un paso del que depende no llegó a terminar.';
        this.setStatus(ctx, st, 'BLOCKED', st.blockedReason);
      }
    }

    const integrate = ctx.plan.steps.find((s) => s.kind === 'integrate');
    const integrateState = integrate !== undefined ? this.stateOf(ctx, integrate.id) : null;
    const finalResult = integrateState?.status === 'DONE' ? (integrateState.result?.text ?? null) : null;
    const failedSteps = ctx.state.steps.filter((s) => s.status === 'FAILED');
    const verdict = latestVerdict(ctx.state.qaRounds);
    const success = finalResult !== null && failedSteps.length === 0 && verdict !== 'BLOCKED';

    ctx.state.phase = success ? 'completed' : 'failed';
    ctx.state.completedAt = this.now();
    ctx.state.cost = await this.d.cost.summary({ runId: ctx.runId });
    await this.flush(ctx);

    const error = success
      ? null
      : failedSteps.length > 0
        ? `${failedSteps.length === 1 ? 'Ha fallado' : 'Han fallado'} ${plural(failedSteps.length, 'paso', 'pasos')}: ${failedSteps.map((s) => ctx.plan.steps.find((p) => p.id === s.stepId)?.title ?? s.stepId).join(', ')}.`
        : finalResult === null
          ? 'No se pudo generar el informe final.'
          : 'La revisión bloqueó el resultado.';

    await this.closeLegacy(ctx, success ? 'completed' : 'failed', finalResult, error);
    await this.remember(ctx, success, finalResult);
    await this.d.audit.record('engine', success ? 'run.completed' : 'run.failed', success ? 'Ejecución completada.' : `La ejecución falló: ${error}`, this.ids(ctx), {
      verdict,
      cost: ctx.state.cost.knownUsd,
      steps: ctx.state.steps.map((s) => ({ id: s.stepId, status: s.status })),
    });
    return { runId: ctx.runId, status: success ? 'completed' : 'failed', phase: ctx.state.phase, finalResult, verdict };
  }

  private async closeLegacy(ctx: RunContext, status: 'completed' | 'failed', finalResult: string | null, error: string | null): Promise<void> {
    const at = this.clock.now();
    await this.d.mirror?.finalize(ctx.runId);
    const run = await this.d.repositories.runs.findById(ctx.runId);
    if (run === null || run.status === 'completed' || run.status === 'failed') return;
    await this.d.repositories.runs.markFinished(ctx.runId, status, at, { finalResult, error });
    await this.d.repositories.missions.setFinalResult(ctx.missionId, finalResult, status, at);
  }

  private async remember(ctx: RunContext, success: boolean, finalResult: string | null): Promise<void> {
    const intent = ctx.plan.compiled.intent;
    const verdict = latestVerdict(ctx.state.qaRounds);
    try {
      await this.d.memory.remember({
        type: 'mission_history',
        scope: 'mission',
        title: `Misión ${success ? 'completada' : 'finalizada'}: ${intent.subject ?? ctx.prompt}`.slice(0, 200),
        content: `Tipo: ${intent.kind}. Pasos: ${ctx.state.steps.length}. Veredicto: ${verdict ?? 'ninguno'}. Coste estimado: ${ctx.state.cost.knownUsd} USD${ctx.state.cost.unpricedCalls > 0 ? ` (+${plural(ctx.state.cost.unpricedCalls, 'llamada sin precio', 'llamadas sin precio')})` : ''}.`,
        origin: 'system',
        missionId: ctx.missionId,
        runId: ctx.runId,
        tags: [intent.kind],
      });
      if (finalResult !== null) {
        await this.d.memory.remember({
          type: 'result',
          scope: 'mission',
          title: `Informe final: ${intent.subject ?? ctx.prompt}`.slice(0, 200),
          content: finalResult.slice(0, 4000),
          origin: 'agent',
          ref: ctx.runId,
          missionId: ctx.missionId,
          runId: ctx.runId,
          tags: [intent.kind, 'final-brief'],
        });
      }
      const last = ctx.state.qaRounds.at(-1);
      if (last !== undefined && last.verdict !== 'PASS') {
        const majors = last.issues.filter((i) => i.severity === 'major' || i.severity === 'blocker');
        if (majors.length > 0) {
          await this.d.memory.recordLesson({
            title: `La revisión encontró ${plural(majors.length, 'problema abierto', 'problemas abiertos')} en una misión de tipo ${intent.kind}`,
            content: majors.slice(0, 5).map((i) => i.message).join(' '),
            missionId: ctx.missionId,
            runId: ctx.runId,
            tags: [intent.kind, 'qa'],
          });
        }
      }
    } catch (error) {
      // Memory is best-effort: it must not change how a run ends. It is said, though.
      await this.d.audit.record('memory', 'memory.write_failed', `No se pudo guardar el recuerdo de esta ejecución: ${errorDetail(error)}`, this.ids(ctx));
    }
  }

  private async abort(ctx: RunContext, error: unknown): Promise<EngineOutcome> {
    const message = errorDetail(error);
    ctx.state.phase = 'failed';
    ctx.state.completedAt = this.now();
    for (const st of ctx.state.steps) {
      if (!BACKGROUND_STATES.has(st.status)) this.setStatus(ctx, st, 'FAILED', `El motor se detuvo: ${message}`);
    }
    // Closing after a failure is best-effort, but never invisible: if the state or
    // the legacy rows could not be closed, the audit event says so, and boot-time
    // recovery finishes the job.
    const closing: string[] = [];
    await this.flush(ctx).catch((e: unknown) => closing.push(`estado: ${errorDetail(e)}`));
    await this.closeLegacy(ctx, 'failed', null, message).catch((e: unknown) => closing.push(`registro: ${errorDetail(e)}`));
    await this.d.audit.record(
      'engine',
      'run.aborted',
      `El motor se detuvo: ${message}${closing.length > 0 ? ` No se pudo cerrar del todo (${closing.join('; ')}); se completará al reiniciar.` : ''}`,
      this.ids(ctx),
      closing.length > 0 ? { closeErrors: closing } : null,
    );
    return { runId: ctx.runId, status: 'failed', phase: 'failed', finalResult: null, verdict: latestVerdict(ctx.state.qaRounds) };
  }
}

function terminalOutcome(ctx: RunContext): EngineOutcome | null {
  const { phase } = ctx.state;
  if (phase !== 'completed' && phase !== 'failed' && phase !== 'cancelled') return null;
  const integrate = ctx.plan.steps.find((s) => s.kind === 'integrate');
  const st = integrate !== undefined ? ctx.state.steps.find((s) => s.stepId === integrate.id) : undefined;
  return {
    runId: ctx.runId,
    status: phase,
    phase,
    finalResult: st?.status === 'DONE' ? (st.result?.text ?? null) : null,
    verdict: latestVerdict(ctx.state.qaRounds),
  };
}
