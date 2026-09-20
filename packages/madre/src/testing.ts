/** Test helpers. Not exported from the package index. */

import { newId, pipelineOrder, type ProviderDescriptor } from '@acc/domain';
import { createProviderRegistry } from '@acc/providers';
import { createMemoryRepositories } from '@acc/repositories/memory';

import { AuditLog } from './audit.ts';
import { ClassicPlanner } from './compiler/classic.ts';
import { RulesPlanner } from './compiler/planner.ts';
import { CostController, type PriceTable } from './cost/controller.ts';
import { MadreEngine, type EngineOptions } from './execution/engine.ts';
import { RepositoryMirror } from './execution/mirror.ts';
import { ProviderStepRunner, type ProviderLookup, type StepRunInput, type StepRunOutput, type StepRunner } from './execution/runner.ts';
import { MemoryService } from './memory/service.ts';
import { ApprovalService } from './permissions/approvals.ts';
import { PermissionPolicy } from './permissions/policy.ts';
import { RulesJudge } from './qa/judge.ts';
import { createAgentRegistry } from './registry/agents.ts';
import { ProviderCatalog } from './registry/providers.ts';
import { createToolRegistry } from './registry/tools.ts';
import { SmartRouter, type RouterOptions } from './router/router.ts';
import { MadreStore } from './store.ts';
import { LocalToolExecutor } from './tools/executor.ts';
import { ToolPipeline } from './tools/pipeline.ts';
import type { Budget, MissionPlan } from './types.ts';
import type { Clock } from './util.ts';

export class FakeClock implements Clock {
  constructor(private current = Date.UTC(2026, 8, 19, 12, 0, 0)) {}
  now(): Date {
    return new Date(this.current);
  }
  advance(ms: number): void {
    this.current += ms;
  }
}

export function createHarness() {
  const repos = createMemoryRepositories();
  const clock = new FakeClock();
  const store = new MadreStore(repos.documents, clock);
  const audit = new AuditLog(store);
  return { repos, clock, store, audit };
}

// ---------------------------------------------------------------------------
// Scripted runners
// ---------------------------------------------------------------------------

/** Text that satisfies every check of the rules judge, for any agent. */
export function goodWorkerText(input: StepRunInput): string {
  const limits = input.caveats.length > 0 ? ' Estos puntos vienen del conocimiento del modelo, están sin verificar y hay que contrastarlos con fuentes.' : '';
  return [
    `${input.step.title}. Para «${input.missionPrompt.replace(/\[[a-z]+:[^\]]*\]/gi, '').trim()}» la respuesta empieza por el posicionamiento y el segmento objetivo.`,
    'Los criterios de éxito son medibles y se nombra el riesgo principal. Se enumeran el mercado, los actores comparables de la competencia y las restricciones a comprobar, con las preguntas abiertas marcadas como desconocidas hasta investigarlas.',
    'El stack tecnológico y las fases vienen con el riesgo principal. Se describen el recorrido de la persona usuaria, la dirección visual y la pantalla clave. Se fijan el mensaje principal, el canal y la métrica de éxito.',
    'Los costes, el margen y la condición de punto de equilibrio se plantean como supuestos que hay que probar con la persona usuaria.' + limits,
  ].join('\n\n');
}

export function goodIntegratorText(input: StepRunInput): string {
  const lines = [`# ${input.plan.deliverableTitle}`];
  for (const section of input.plan.deliverableSections) {
    if (/^(?:pr[oó]ximas acciones|next actions)$/i.test(section.trim())) continue;
    lines.push(`## ${section}\n${input.missionPrompt.replace(/\[[a-z]+:[^\]]*\]/gi, '').trim()} — esta sección recoge lo que encontraron los especialistas y lo que sigue sin saberse.`);
  }
  if (input.failed.length > 0) {
    lines.push(`## Sin resolver\nEstos pasos no se completaron y faltan: ${input.failed.map((f) => f.title).join(', ')}.`);
  }
  lines.push(
    '## Próximas acciones',
    '1. Pide esta semana a diez compradores probables que hagan una reserva y cuenta cuántos la hacen.',
    '2. Comprueba con el organismo competente las normas que aplican antes de vender nada.',
  );
  return lines.join('\n\n');
}

export function goodText(input: StepRunInput): string {
  if (input.step.kind === 'integrate') return goodIntegratorText(input);
  if (input.step.kind === 'qa') {
    return `Revisión del trabajo de los especialistas para «${input.missionPrompt}». ${input.reviewSummary ?? ''}\n\n${'El juez ha listado arriba sus hallazgos y no se ha cambiado nada más. '.repeat(3)}`;
  }
  return goodWorkerText(input);
}

export type RunnerFn = (input: StepRunInput, signal?: AbortSignal) => string | Promise<string>;

export class ScriptedRunner implements StepRunner {
  readonly calls: StepRunInput[] = [];
  active = 0;
  maxActive = 0;

  constructor(private readonly fn: RunnerFn = goodText, private readonly delayMs = 0) {}

  async run(input: StepRunInput, signal?: AbortSignal): Promise<StepRunOutput> {
    this.calls.push(structuredClone({ ...input, agent: undefined }) as unknown as StepRunInput);
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
      if (signal?.aborted) throw new Error('aborted');
      const text = await this.fn(input, signal);
      return {
        text,
        provider: input.provider.id,
        model: input.provider.model,
        requestId: `req-${this.calls.length}`,
        promptTokens: 100,
        completionTokens: 50,
        latencyMs: 5,
        source: input.provider.id === 'mock' ? 'mock' : 'real',
        simulated: input.provider.id === 'mock',
      };
    } finally {
      this.active -= 1;
    }
  }

  callsFor(stepId: string): StepRunInput[] {
    return this.calls.filter((c) => c.step.id === stepId);
  }
}

export const OLLAMA_MIXED: ProviderDescriptor = {
  id: 'ollama',
  label: 'Ollama',
  availability: 'available',
  models: [
    { id: 'llama3.1:8b', label: '8b' },
    { id: 'llama3.1:70b', label: '70b' },
  ],
};
export const ANTHROPIC: ProviderDescriptor = { id: 'anthropic', label: 'Anthropic', availability: 'available', models: [{ id: 'big', label: 'big' }] };
export const MOCK: ProviderDescriptor = { id: 'mock', label: 'Mock', availability: 'available', models: [{ id: 'mock-1', label: 'Mock' }] };
export const PLANNED_OPENAI: ProviderDescriptor = { id: 'openai', label: 'OpenAI', availability: 'planned', models: [] };

export interface EngineHarnessOptions {
  descriptors?: ProviderDescriptor[];
  /**
   * A real provider registry (adapters and all). The catalog reads its
   * descriptors and, unless `runner` is given, steps run through it — so a test
   * can drive a mission through the actual adapters with a fake `fetch`.
   */
  providerRegistry?: ProviderLookup & { describe(): ProviderDescriptor[] };
  runner?: StepRunner;
  budget?: Budget;
  /** Prices per 1k tokens, keyed `provider` or `provider:model`. */
  prices?: PriceTable;
  engine?: Partial<EngineOptions>;
  planner?: RulesPlanner;
  /** Router settings, e.g. a routing policy with a different circuit-breaker threshold. */
  router?: RouterOptions;
  /** Rewrite the plan before it is stored, to build scenarios the templates do not produce. */
  mutatePlan?: (plan: MissionPlan) => void;
}

export function createEngineHarness(options: EngineHarnessOptions = {}) {
  const { repos, clock, store, audit } = createHarness();
  const agents = createAgentRegistry();
  const tools = createToolRegistry();
  const descriptors = options.descriptors ?? [OLLAMA_MIXED];
  const catalog = new ProviderCatalog(() => options.providerRegistry?.describe() ?? descriptors);
  const policy = new PermissionPolicy();
  const cost = new CostController(store, options.budget, options.prices);
  const memory = new MemoryService(store);
  const approvals = new ApprovalService(store);
  const router = new SmartRouter(agents, catalog, tools, policy, cost, { clock, ...options.router });
  catalog.attachCircuit((providerId) => router.circuitState(providerId));
  const basePlanner = options.planner ?? new RulesPlanner(agents, tools);
  const planner = options.mutatePlan
    ? {
        plan: (text: string, o?: Parameters<RulesPlanner['plan']>[1]) => {
          const plan = basePlanner.plan(text, o);
          options.mutatePlan!(plan);
          return plan;
        },
      }
    : basePlanner;
  const runner = options.runner ?? (options.providerRegistry !== undefined ? new ProviderStepRunner(options.providerRegistry) : new ScriptedRunner());
  const mirror = new RepositoryMirror(agents, repos.agents, clock);
  const sleeps: number[] = [];
  const toolPipeline = new ToolPipeline({ tools, policy, cost, audit, executor: new LocalToolExecutor(tools, memory) });
  const engineDeps: ConstructorParameters<typeof MadreEngine>[0] = {
    repositories: repos,
    store,
    audit,
    approvals,
    memory,
    cost,
    router,
    agents,
    tools,
    providers: catalog,
    judge: new RulesJudge(),
    runner,
    toolPipeline,
    planner,
    classicPlanner: new ClassicPlanner(agents),
    mirror,
    clock,
    sleep: (ms, signal) => {
      sleeps.push(ms);
      if (signal?.aborted) return Promise.reject(new Error('Aborted'));
      return Promise.resolve();
    },
    options: { parallelism: 2, agentTimeoutMs: 5_000, ...options.engine },
  };
  const engine = new MadreEngine(engineDeps);
  /** A second engine over the same data: the process that starts after a restart. */
  const newEngine = () => new MadreEngine(engineDeps);

  async function startRun(prompt: string, provider: { providerId: string; model: string } = { providerId: 'mock', model: 'mock-1' }): Promise<{ missionId: string; runId: string }> {
    const now = clock.now();
    const mission = await repos.missions.create({ id: newId(), prompt, title: prompt.slice(0, 60), createdAt: now });
    const run = await repos.runs.create({ id: newId(), missionId: mission.id, attempt: 1, providerId: provider.providerId, model: provider.model, createdAt: now });
    await repos.agents.createMany(
      pipelineOrder().map((d, i) => ({ id: newId(), missionId: mission.id, runId: run.id, agentId: d.id, name: d.name, orderIndex: i, task: 'x' })),
    );
    return { missionId: mission.id, runId: run.id };
  }

  return { repos, clock, store, audit, agents, tools, catalog, policy, cost, memory, approvals, router, runner, engine, newEngine, toolPipeline, sleeps, startRun };
}

export { ProviderStepRunner, createProviderRegistry };
