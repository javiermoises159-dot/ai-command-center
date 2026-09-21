/**
 * MADRE application layer.
 *
 * `createMadre` is the composition root for everything in this package: it
 * builds the registries, router, cost controller, memory, engine and the
 * service the HTTP layer calls. The server passes in its repositories and
 * provider registry; nothing here imports an HTTP framework or a vendor SDK.
 */

import { systemClock, type Clock, type Job, type ProviderDescriptor, type Repositories } from '@acc/domain';

import { AuditLog } from './audit.ts';
import { ClassicPlanner } from './compiler/classic.ts';
import { RulesPlanner, type Planner } from './compiler/planner.ts';
import { CostController, type PriceTable } from './cost/controller.ts';
import { MadreEngine, type EngineOptions } from './execution/engine.ts';
import { RepositoryMirror } from './execution/mirror.ts';
import { RunRecovery, type RecoveryReport } from './execution/recovery.ts';
import { ProviderStepRunner, type ProviderLookup, type StepRunner } from './execution/runner.ts';
import { MemoryService, type RecalledEntry, type RecallQuery, type RememberInput, type RememberOutcome } from './memory/service.ts';
import { ApprovalError, ApprovalService } from './permissions/approvals.ts';
import { PermissionPolicy } from './permissions/policy.ts';
import { RulesJudge } from './qa/judge.ts';
import { buildTrace } from './observability/trace.ts';
import { checkAllProviders, type FetchLike as HealthFetch, type ProbeReport } from './registry/health.ts';
import { createAgentRegistry, type AgentRegistry } from './registry/agents.ts';
import { ProviderCatalog } from './registry/providers.ts';
import { createToolRegistry, type ToolRegistry } from './registry/tools.ts';
import { SmartRouter } from './router/router.ts';
import { KINDS, MadreStore } from './store.ts';
import { LocalToolExecutor } from './tools/executor.ts';
import type { PageFetcher } from './tools/safe-fetch.ts';
import type { WebFetch } from './tools/web.ts';
import { ToolPipeline } from './tools/pipeline.ts';
import type {
  ApprovalRequest,
  AuditEvent,
  Budget,
  CostRecord,
  CostSummary,
  MadreRunState,
  MadreSnapshot,
  MemoryEntry,
  MissionPlan,
  MissionTrace,
  PermissionLevel,
  PermissionMode,
  RoutingDecision,
  RunMode,
  AgentSpec,
  ProviderProfile,
  ToolSpec,
  WorldModel,
} from './types.ts';
import { buildWorldModel } from './world/builder.ts';
import { planContentPipeline } from './pipelines/content.ts';
import { planMediaPipeline } from './pipelines/media.ts';
import type { PipelineReport } from './pipelines/stages.ts';

export interface MadreConfig {
  repositories: Repositories;
  providers: ProviderLookup & {
    describe(): ProviderDescriptor[];
    /** Ask an adapter to probe itself. Absent on registries that offer no probes. */
    probe?(providerId: string, signal?: AbortSignal): Promise<ProbeReport | null>;
  };
  /** Provider ids the operator switched off (`MADRE_DISABLED_PROVIDERS`). They are never routed to. */
  disabledProviders?: readonly string[];
  /** Used to queue the continuation of a paused run once its approvals are decided. */
  enqueue: (job: Job) => Promise<unknown>;
  clock?: Clock;
  budget?: Budget;
  prices?: PriceTable;
  permissionOverrides?: Partial<Record<PermissionLevel, PermissionMode>>;
  engine?: Partial<EngineOptions>;
  /** Replace the step runner (tests). Defaults to one that calls the provider registry. */
  runner?: StepRunner;
  planner?: Planner;
  /** How the classic pipeline behaves when a specialist fails. Default: carry on and say what is missing. */
  classic?: { continueOnWorkerFailure?: boolean };
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Only used to probe the local model server's health. Never sent to the browser. */
  ollamaBaseUrl?: string | undefined;
  /** Tavily key for `web.search`. Absent leaves the tool NOT_CONNECTED. Never sent to the browser. */
  webSearchApiKey?: string | undefined;
  /** What the creative studio can really do today (script, image, voice, edit, transcribe, reel). Shown in the pipelines report. */
  studio?: readonly string[] | undefined;
  /** Alternate between equally good providers, step by step. Off by default. */
  balanceProviders?: boolean | undefined;
  /** Turns on `news.gdelt` (public news API, no key). Off by default. */
  enableNews?: boolean;
  /** Turns on `research.wikipedia` (public API, no key). Off by default so nothing reaches the network unasked. */
  enableWikipedia?: boolean | undefined;
  /** Turns on `web.fetch` and lets `web.search` read its top pages. Off by default. */
  enableWebFetch?: boolean | undefined;
  /** Injected in tests so tools never touch the network. */
  toolFetch?: WebFetch | undefined;
  pageFetcher?: PageFetcher | undefined;
  /** Injected in tests so a health probe never touches the network. */
  healthFetch?: HealthFetch;
}

export interface CompilePreview {
  plan: MissionPlan;
  routing: RoutingDecision[];
}

export interface Overview {
  world: WorldModel;
  pendingApprovals: number;
  recent: AuditEvent[];
  pipelines: { content: PipelineReport; media: PipelineReport };
}

export class MadreNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MadreNotFoundError';
  }
}

export class MadreService {
  constructor(
    private readonly d: {
      repositories: Repositories;
      store: MadreStore;
      audit: AuditLog;
      agents: AgentRegistry;
      tools: ToolRegistry;
      catalog: ProviderCatalog;
      policy: PermissionPolicy;
      cost: CostController;
      memory: MemoryService;
      approvals: ApprovalService;
      router: SmartRouter;
      planner: Planner;
      engine: MadreEngine;
      enqueue: (job: Job) => Promise<unknown>;
      studio?: ReadonlySet<string> | undefined;
      clock: Clock;
      /** Only used to probe the local model server. Never leaves the server. */
      ollamaBaseUrl?: string | undefined;
      healthFetch?: HealthFetch | undefined;
      /** The adapters' own reachability probes. */
      probe?: ((providerId: string) => Promise<ProbeReport | null>) | undefined;
    },
  ) {}

  // -- registries -----------------------------------------------------------

  agents(): AgentSpec[] {
    return this.d.agents.list();
  }

  providers(): ProviderProfile[] {
    return this.d.catalog.profiles();
  }

  /**
   * Probe every provider and record the outcome.
   *
   * This is the only thing that may set a provider's health: nothing infers
   * reachability from configuration. Returns the refreshed profiles.
   */
  async checkProviderHealth(): Promise<ProviderProfile[]> {
    const results = await checkAllProviders(this.d.catalog.profiles(), {
      now: () => this.d.store.clock.now(),
      ollamaBaseUrl: this.d.ollamaBaseUrl,
      ...(this.d.healthFetch === undefined ? {} : { fetch: this.d.healthFetch }),
      ...(this.d.probe === undefined ? {} : { probe: this.d.probe }),
    });
    for (const [providerId, health] of results) this.d.catalog.recordHealth(providerId, health);
    return this.d.catalog.profiles();
  }

  tools(): ToolSpec[] {
    return this.d.tools.list();
  }

  permissions(): Record<PermissionLevel, PermissionMode> {
    return this.d.policy.configured();
  }

  // -- compile and route (no side effects) -----------------------------------

  async compile(text: string): Promise<CompilePreview> {
    const plan = this.d.planner.plan(text, { clock: this.d.clock });
    const decisions = await this.d.router.routePlan(plan);
    return { plan, routing: plan.steps.flatMap((s) => (decisions.has(s.id) ? [decisions.get(s.id)!] : [])) };
  }

  // -- mission snapshot -------------------------------------------------------

  /** The MADRE view of a mission: its newest MADRE run, or `runId: null` if it has none. */
  async snapshot(missionId: string): Promise<MadreSnapshot> {
    const detail = await this.d.repositories.missions.findDetail(missionId);
    if (detail === null) throw new MadreNotFoundError(`La misión ${missionId} no existe.`);
    const runs = [...detail.runs].sort((a, b) => b.run.attempt - a.run.attempt);
    for (const { run } of runs) {
      const state = await this.d.store.get<MadreRunState>(KINDS.runState, run.id);
      if (state === null) continue;
      const plan = await this.d.store.get<MissionPlan>(KINDS.plan, run.id);
      const approvals = await this.d.approvals.forRun(run.id);
      // Oldest first, so a cap would cut the END of the run. Each provider call now
      // leaves several events, so the cap is generous rather than a silent truncation.
      const audit = await this.d.audit.forMission(missionId, 1000);
      return { missionId, runId: run.id, plan, state, approvals, audit: audit.filter((e) => e.runId === null || e.runId === run.id) };
    }
    return { missionId, runId: null, plan: null, state: null, approvals: [], audit: await this.d.audit.forMission(missionId, 100) };
  }

  /**
   * The full chain behind one mission: step by step, which model ran it, which
   * tools it called, what it cost, what QA said and what a person decided.
   *
   * Assembled from records that already exist, so it cannot drift from what
   * happened. Returns null when the mission has no run yet.
   */
  async trace(missionId: string): Promise<MissionTrace | null> {
    const snapshot = await this.snapshot(missionId);
    if (snapshot.runId === null || snapshot.state === null) return null;
    const costs = await this.d.store.list<CostRecord>(KINDS.cost, { runId: snapshot.runId, order: 'asc' });
    return buildTrace({
      missionId,
      runId: snapshot.runId,
      plan: snapshot.plan,
      state: snapshot.state,
      qaRounds: snapshot.state.qaRounds,
      costs,
      approvals: snapshot.approvals,
      audit: snapshot.audit,
    });
  }

  // -- approvals ---------------------------------------------------------------

  pendingApprovals(): Promise<ApprovalRequest[]> {
    return this.d.approvals.pending();
  }

  /**
   * Record a decision. Once no approval of that run is still pending, the run
   * is queued to continue; the engine reads the decisions and either proceeds
   * or blocks the steps that were denied.
   */
  async decide(id: string, decision: 'approved' | 'denied', note: string | null = null): Promise<ApprovalRequest> {
    let approval: ApprovalRequest;
    try {
      approval = await this.d.approvals.decide(id, decision, note);
    } catch (error) {
      if (error instanceof ApprovalError && error.code === 'not_found') throw new MadreNotFoundError(error.message);
      throw error;
    }
    await this.d.audit.record('user', `approval.${decision}`, `${decision === 'approved' ? 'Aprobado' : 'Denegado'}: ${approval.title}`, { missionId: approval.missionId, runId: approval.runId }, { approvalId: id, note });

    const remaining = (await this.d.approvals.forRun(approval.runId)).filter((a) => a.status === 'pending');
    if (remaining.length === 0 && !this.d.engine.isActive(approval.runId)) {
      await this.d.enqueue({ type: 'execute-run', runId: approval.runId, missionId: approval.missionId, mode: 'madre', resume: true });
    }
    return approval;
  }

  // -- control -------------------------------------------------------------------

  /**
   * Cancels the mission's active run, whether it is executing, paused for a
   * person, or still waiting in the queue. Returns false only when there is
   * nothing active to cancel.
   */
  async cancel(missionId: string): Promise<boolean> {
    if ((await this.d.repositories.missions.findById(missionId)) === null) {
      throw new MadreNotFoundError(`La misión ${missionId} no existe.`);
    }
    const active = await this.d.repositories.runs.findActiveByMission(missionId);
    if (active === null) return false;
    return this.d.engine.cancel(active.id);
  }

  // -- memory, budget, cost, world -------------------------------------------------

  recall(query: RecallQuery = {}): Promise<RecalledEntry[]> {
    return this.d.memory.recall(query);
  }
  listMemory(query: Parameters<MemoryService['list']>[0] = {}): Promise<MemoryEntry[]> {
    return this.d.memory.list(query);
  }
  /** Store something the user tells MADRE. It is never marked verified without a reference. */
  remember(input: Pick<RememberInput, 'type' | 'scope' | 'title' | 'content' | 'tags' | 'ref'>): Promise<RememberOutcome> {
    return this.d.memory.remember({ ...input, origin: 'user' });
  }
  forget(id: string): Promise<boolean> {
    return this.d.memory.forget(id);
  }
  memoryStats(): ReturnType<MemoryService['stats']> {
    return this.d.memory.stats();
  }

  budget(): Budget {
    return this.d.cost.getBudget();
  }
  setBudget(budget: Budget): void {
    this.d.cost.setBudget(budget);
  }
  costSummary(filter: { missionId?: string; runId?: string } = {}): Promise<CostSummary> {
    return this.d.cost.summary(filter);
  }

  recentAudit(limit = 100): Promise<AuditEvent[]> {
    return this.d.audit.recent(limit);
  }

  world(): Promise<WorldModel> {
    return buildWorldModel({
      missions: this.d.repositories.missions,
      memory: this.d.memory,
      approvals: this.d.approvals,
      agents: this.d.agents,
      tools: this.d.tools,
      providers: this.d.catalog,
      policy: this.d.policy,
      cost: this.d.cost,
      clock: this.d.clock,
    });
  }

  async overview(): Promise<Overview> {
    const [world, pending, recent] = await Promise.all([this.world(), this.d.approvals.pending(), this.d.audit.recent(20)]);
    const deps = { agents: this.d.agents, tools: this.d.tools, policy: this.d.policy, ...(this.d.studio !== undefined ? { studio: this.d.studio } : {}) };
    return { world, pendingApprovals: pending.length, recent, pipelines: { content: planContentPipeline(deps), media: planMediaPipeline(deps) } };
  }
}

export interface Madre {
  service: MadreService;
  engine: MadreEngine;
  store: MadreStore;
  agents: AgentRegistry;
  tools: ToolRegistry;
  catalog: ProviderCatalog;
  policy: PermissionPolicy;
  cost: CostController;
  memory: MemoryService;
  approvals: ApprovalService;
  audit: AuditLog;
  router: SmartRouter;
  /** Run a queued MADRE job to completion, pause or failure. */
  execute(job: { runId: string; resume?: boolean; mode?: RunMode }): Promise<void>;
  /** True when a run has MADRE state and is paused, waiting for a person. */
  isPaused(runId: string): Promise<boolean>;
  /**
   * Reconcile everything a restart left behind: no run or step stays `running`,
   * and the run state, the legacy rows and the mission agree. Idempotent. Call
   * once at boot, before the queue starts. Paused runs whose approvals are all
   * decided are queued to continue.
   */
  recover(): Promise<RecoveryReport>;
  /** Every way this mission's records disagree right now. Empty when they all tell the same story. */
  inspect(missionId: string): Promise<string[]>;
}

export function createMadre(config: MadreConfig): Madre {
  const clock = config.clock ?? systemClock;
  const store = new MadreStore(config.repositories.documents, clock);
  const audit = new AuditLog(store);
  const agents = createAgentRegistry();
  const tools = createToolRegistry();
  const catalog = new ProviderCatalog(() => config.providers.describe());
  for (const id of config.disabledProviders ?? []) catalog.disable(id, 'MADRE_DISABLED_PROVIDERS.');
  const policy = new PermissionPolicy(config.permissionOverrides);
  const cost = new CostController(store, config.budget, config.prices);
  const memory = new MemoryService(store);
  const approvals = new ApprovalService(store);
  const router = new SmartRouter(agents, catalog, tools, policy, cost, { clock, balanceTies: config.balanceProviders === true });
  catalog.attachCircuit((providerId) => router.circuitState(providerId));
  const planner = config.planner ?? new RulesPlanner(agents, tools);
  const runner = config.runner ?? new ProviderStepRunner(config.providers);

  if (config.enableWikipedia === true) {
    tools.setStatus('research.wikipedia', 'AVAILABLE', 'API pública de Wikipedia, sin clave. Devuelve la introducción del artículo que mejor coincide, con su URL.');
  }
  if (config.enableNews === true) {
    tools.setStatus('news.gdelt', 'AVAILABLE', 'Noticias recientes de GDELT (gratuito, sin clave). Devuelve titulares con enlace; el texto se trata como dato.');
  }
  if (config.enableWebFetch === true) {
    tools.setStatus('web.fetch', 'AVAILABLE', 'Lee páginas web públicas (http/https). Bloquea localhost y redes privadas; el texto se trata como dato, nunca como instrucciones.');
  }
  if (config.webSearchApiKey !== undefined && config.webSearchApiKey.trim() !== '') {
    tools.setStatus('web.search', 'AVAILABLE', 'Conectada a Tavily (plan gratuito). Las consultas salen del servidor; la clave nunca llega al navegador.');
  }
  const toolPipeline = new ToolPipeline({
    tools, policy, cost, audit,
    executor: new LocalToolExecutor(tools, memory, { fetch: config.toolFetch, searchApiKey: config.webSearchApiKey?.trim() || undefined, pageFetcher: config.pageFetcher, enrichSearch: config.enableWebFetch === true }),
  });

  const engine = new MadreEngine({
    repositories: config.repositories,
    store, audit, approvals, memory, cost, router, agents, tools,
    providers: catalog,
    judge: new RulesJudge(),
    runner,
    toolPipeline,
    planner,
    classicPlanner: new ClassicPlanner(agents, config.classic),
    mirror: new RepositoryMirror(agents, config.repositories.agents, clock),
    clock,
    ...(config.sleep !== undefined ? { sleep: config.sleep } : {}),
    ...(config.engine !== undefined ? { options: config.engine } : {}),
  });

  const service = new MadreService({
    repositories: config.repositories, store, audit, agents, tools, catalog, policy, cost, memory, approvals, router, planner, engine,
    enqueue: config.enqueue, studio: new Set(config.studio ?? []), clock, ollamaBaseUrl: config.ollamaBaseUrl, healthFetch: config.healthFetch,
    probe: config.providers.probe === undefined ? undefined : (id) => config.providers.probe!(id),
  });

  const recovery = new RunRecovery({
    repositories: config.repositories, store, audit, approvals, cost, agents, clock,
    isActive: (runId) => engine.isActive(runId),
  });

  return {
    service, engine, store, agents, tools, catalog, policy, cost, memory, approvals, audit, router,
    async execute(job) {
      await engine.execute(job);
    },
    async isPaused(runId) {
      const state = await store.get<MadreRunState>(KINDS.runState, runId);
      return state?.phase === 'paused';
    },
    async recover() {
      const report = await recovery.recover();
      for (const run of report.resumable) {
        await config.enqueue({ type: 'execute-run', runId: run.runId, missionId: run.missionId, mode: 'madre', resume: true });
      }
      return report;
    },
    inspect: (missionId) => recovery.inspect(missionId),
  };
}
