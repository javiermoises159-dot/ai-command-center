/**
 * Planner.
 *
 * Schedules a `CompiledMission` as a `MissionPlan`: one step per task, then QA,
 * then the integrator, with hard and soft dependencies and the waves of steps
 * that may run together. It also records *gaps*: capabilities the mission
 * wants that no active agent or usable tool can provide in this build. Gaps are
 * reported, never papered over.
 */

import { newId } from '@acc/domain';

import type { AgentRegistry } from '../registry/agents.ts';
import type { ToolRegistry } from '../registry/tools.ts';
import type {
  AgentSpec,
  AgentTask,
  Capability,
  CapabilityGap,
  CompiledMission,
  MissionPlan,
  MissionStep,
  MissionTask,
  StepDependency,
  ToolRequest,
} from '../types.ts';
import { systemClock, unique, type Clock } from '../util.ts';
import { compileMission, taskIdFor, type CompileOptions } from './compile.ts';
import { describeCapability } from '../capabilities.ts';
import { keywords } from '../tools/web.ts';

export interface PlanOptions {
  missionId?: string | null;
  clock?: Clock;
  version?: number;
  /** Documents the user attached, for document analysis. */
  providedDocuments?: number;
  maxAttempts?: number;
}

export const QA_STEP_ID = 's-qa';
export const INTEGRATE_STEP_ID = 's-integrate';
export const INPUT_STEP_ID = 's-input-documents';

const stepIdFor = (taskId: string): string => `s${taskId.slice(1)}`;

const DIFFICULTY: Partial<Record<Capability, 1 | 2 | 3 | 4 | 5>> = {
  'strategy.positioning': 4,
  'strategy.assumptions': 4,
  'strategy.prioritization': 3,
  'research.market': 3,
  'research.competitors': 3,
  'research.regulatory': 4,
  'research.audience': 3,
  'research.documents': 3,
  'finance.unit_economics': 4,
  'finance.budget': 3,
  'finance.experiment_cost': 3,
  'marketing.go_to_market': 3,
  'marketing.campaign': 3,
  'marketing.messaging': 2,
  'engineering.architecture': 4,
  'engineering.build_plan': 3,
  'design.ux': 3,
  'design.brand': 2,
  'design.logo': 3,
  'design.visual_brief': 2,
  'qa.review': 4,
  'integration.brief': 3,
};

const FRESH: ReadonlySet<Capability> = new Set([
  'research.market',
  'research.competitors',
  'research.regulatory',
  'research.audience',
]);

export interface Planner {
  plan(text: string, options?: PlanOptions): MissionPlan;
}

export class RulesPlanner implements Planner {
  readonly id = 'rules-planner@1';

  constructor(
    private readonly agents: AgentRegistry,
    private readonly tools: ToolRegistry,
    private readonly compileOptions: CompileOptions = {},
  ) {}

  plan(text: string, options: PlanOptions = {}): MissionPlan {
    const providedDocuments =
      options.providedDocuments ?? this.compileOptions.providedDocuments ?? (text.length > 800 ? 1 : 0);
    const compiled = compileMission(text, { ...this.compileOptions, providedDocuments });
    return this.planCompiled(compiled, { ...options, providedDocuments });
  }

  planCompiled(compiled: CompiledMission, options: PlanOptions = {}): MissionPlan {
    const clock = options.clock ?? systemClock;
    const maxAttempts = options.maxAttempts ?? 2;
    const intent = compiled.intent;
    const gaps: CapabilityGap[] = [];
    const steps: MissionStep[] = [];
    const warnings = new Set<string>();

    const needsInput =
      intent.kind === 'document_analysis' && (options.providedDocuments ?? 0) === 0;
    if (needsInput) {
      steps.push(this.inputStep());
    }

    const stepByTask = new Map<string, string>();
    const workerSteps: MissionStep[] = [];

    for (const task of compiled.tasks) {
      const agent = this.agents.forCapability(task.capability)[0];
      if (agent === undefined) {
        gaps.push(this.gapFor(task.capability, true));
        continue;
      }
      const stepId = stepIdFor(task.id);
      stepByTask.set(task.id, stepId);
      const step = this.workerStep(stepId, task, agent, compiled, maxAttempts, warnings);
      workerSteps.push(step);
    }

    // Dependencies between workers, and on the input step where there is one.
    for (const step of workerSteps) {
      const task = compiled.tasks.find((t) => stepIdFor(t.id) === step.id)!;
      const deps: StepDependency[] = task.after
        .map((id) => stepByTask.get(id))
        .filter((id): id is string => id !== undefined)
        .map((stepId) => ({ stepId, mode: task.dependency }));
      if (needsInput && task.capability === 'research.documents') deps.push({ stepId: INPUT_STEP_ID, mode: 'hard' });
      step.dependsOn = deps;
      steps.push(step);
    }

    // QA looks at whatever the workers produced, even when some failed.
    const qaAgent = this.agents.forCapability('qa.review')[0];
    const integrator = this.agents.forCapability('integration.brief')[0];
    if (qaAgent === undefined) gaps.push(this.gapFor('qa.review', true));
    if (integrator === undefined) gaps.push(this.gapFor('integration.brief', true));

    const workerIds = workerSteps.map((s) => s.id);
    if (qaAgent !== undefined) {
      steps.push(
        this.systemStep({
          id: QA_STEP_ID,
          title: 'Revisar los resultados',
          kind: 'qa',
          agent: qaAgent,
          capability: 'qa.review',
          dependsOn: workerIds.map((stepId) => ({ stepId, mode: 'soft' as const })),
          instruction:
            'Audita cada resultado de los especialistas frente a la misión y a los criterios de verificación. Informa de los huecos, las contradicciones, los datos sin verificar y las hipótesis presentadas como hechos. No reescribas el trabajo.',
          expected: 'Un veredicto por especialista, las contradicciones encontradas, los huecos y una decisión de seguir o no seguir.',
          compiled,
          maxAttempts,
        }),
      );
    }
    if (integrator !== undefined) {
      const dependsOn: StepDependency[] = [
        ...workerIds.map((stepId) => ({ stepId, mode: 'soft' as const })),
        ...(qaAgent !== undefined ? [{ stepId: QA_STEP_ID, mode: 'hard' as const }] : []),
      ];
      steps.push(
        this.systemStep({
          id: INTEGRATE_STEP_ID,
          title: 'Redactar el informe final',
          kind: 'integrate',
          agent: integrator,
          capability: 'integration.brief',
          dependsOn,
          instruction:
            `Integra todos los resultados y la revisión en un único informe sobre el que una persona pueda actuar. Usa estas secciones: ${compiled.expectedDeliverable.sections.join(', ')}. Arrastra los puntos sin resolver en lugar de descartarlos.`,
          expected: compiled.expectedDeliverable.title,
          compiled,
          maxAttempts,
        }),
      );
    }

    // Everything else the mission wanted and this build cannot do.
    for (const capability of compiled.requiredCapabilities) {
      if (compiled.tasks.some((t) => t.capability === capability)) continue;
      if (capability === 'qa.review' || capability === 'integration.brief') continue;
      const gap = this.gapForCapability(capability);
      if (gap !== null) gaps.push(gap);
    }

    return {
      id: newId(),
      missionId: options.missionId ?? null,
      version: options.version ?? 1,
      createdAt: clock.now().toISOString(),
      planner: this.id,
      compiled,
      steps,
      parallelGroups: computeWaves(steps),
      gaps: dedupeGaps(gaps),
      warnings: [...warnings],
    };
  }

  // ---- step builders -------------------------------------------------------

  private workerStep(
    id: string,
    task: MissionTask,
    agent: AgentSpec,
    compiled: CompiledMission,
    maxAttempts: number,
    warnings: Set<string>,
  ): MissionStep {
    const intent = compiled.intent;
    const fresh = FRESH.has(task.capability) && intent.needsFreshInformation;
    const agentTask: AgentTask = {
      stepId: id,
      agentId: agent.id,
      instruction: task.description,
      expectedOutput: agent.outputs.join('; '),
      constraints: compiled.constraints.map((c) => c.text),
      requiredCapabilities: [task.capability],
      difficulty: DIFFICULTY[task.capability] ?? 3,
      needsFreshInformation: fresh,
      sensitive: intent.sensitivity.involvesPersonalData,
    };
    return {
      id,
      title: task.title,
      kind: 'agent',
      agentId: agent.id,
      capability: task.capability,
      dependsOn: [],
      task: agentTask,
      toolRequests: this.toolRequestsFor(id, agent, task.capability, fresh, searchQuery(compiled, task), warnings, urlsIn(compiled), topicOf(compiled)),
      verification: compiled.verificationCriteria.filter((c) => c.appliesTo.includes('*')).map((c) => c.id),
      maxAttempts,
    };
  }

  private systemStep(input: {
    id: string;
    title: string;
    kind: 'qa' | 'integrate';
    agent: AgentSpec;
    capability: Capability;
    dependsOn: StepDependency[];
    instruction: string;
    expected: string;
    compiled: CompiledMission;
    maxAttempts: number;
  }): MissionStep {
    return {
      id: input.id,
      title: input.title,
      kind: input.kind,
      agentId: input.agent.id,
      capability: input.capability,
      dependsOn: input.dependsOn,
      task: {
        stepId: input.id,
        agentId: input.agent.id,
        instruction: input.instruction,
        expectedOutput: input.expected,
        constraints: input.compiled.constraints.map((c) => c.text),
        requiredCapabilities: [input.capability],
        difficulty: DIFFICULTY[input.capability] ?? 3,
        needsFreshInformation: false,
        sensitive: input.compiled.intent.sensitivity.involvesPersonalData,
      },
      toolRequests: [],
      verification: input.compiled.verificationCriteria.map((c) => c.id),
      maxAttempts: input.maxAttempts,
    };
  }

  private inputStep(): MissionStep {
    return {
      id: INPUT_STEP_ID,
      title: 'Aportar los documentos',
      kind: 'input',
      agentId: 'user',
      capability: 'research.documents',
      dependsOn: [],
      task: {
        stepId: INPUT_STEP_ID,
        agentId: 'user',
        instruction: 'Pega o adjunta los documentos que hay que analizar. El análisis no puede empezar sin ellos.',
        expectedOutput: 'El texto de los documentos.',
        constraints: [],
        requiredCapabilities: [],
        difficulty: 1,
        needsFreshInformation: false,
        sensitive: true,
      },
      toolRequests: [],
      verification: [],
      maxAttempts: 1,
    };
  }

  /**
   * The tool calls a step asks for, each with an input that already satisfies
   * the tool's schema.
   *
   * The planner never emits a request it could not fill in: a request with an
   * empty or invented input would only fail at execution time, so the failure
   * is moved here, where it can be said plainly in `plan.warnings`. A tool whose
   * input depends on something that does not exist yet (the calculator needs an
   * expression, which only appears once a model has produced figures) is not
   * requested at planning time at all.
   */
  private toolRequestsFor(
    stepId: string,
    agent: AgentSpec,
    capability: Capability,
    fresh: boolean,
    query: string,
    warnings: Set<string>,
    urls: readonly string[] = [],
    topicText = '',
  ): ToolRequest[] {
    const requests: ToolRequest[] = [];
    const add = (toolId: string, purpose: string, required: boolean, input: Record<string, unknown> | null, suffix = ''): void => {
      const spec = this.tools.get(toolId);
      if (spec === undefined) return;
      if (input === null) {
        warnings.add(
          `«${spec.name}» (${toolId}) no se pide al planificar: su entrada depende de datos que todavía no existen, así que no se puede construir una entrada válida de antemano.`,
        );
        return;
      }
      const check = this.tools.validateInput(toolId, input);
      if (!check.ok) {
        warnings.add(`«${spec.name}» (${toolId}) no se pide: la entrada que se puede construir no es válida. ${check.errors.join(' ')}`);
        return;
      }
      requests.push({
        id: `${stepId}:${toolId}${suffix}`,
        toolId,
        purpose,
        input,
        permission: spec.permissions[0] ?? 'READ',
        required,
      });
    };
    if (agent.optionalTools.includes('memory.recall') || agent.requiredTools.includes('memory.recall')) {
      add('memory.recall', 'Recordar lo que ya se sabe sobre este usuario y este proyecto.', false, { query, limit: 5 });
    }
    if ((fresh || capability.startsWith('research.')) && agent.optionalTools.includes('web.search')) {
      // Several narrow searches find more than one long one: the topic on its
      // own, then the angles this kind of step needs (competitors, prices, rules).
      const topic = topicText || keywords(query, 6) || query.slice(0, 120);
      const angles = (SEARCH_ANGLES[capability] ?? []).map((angle) => `${angle} ${topic}`);
      // A mission about Italy is also searched in Italian: local businesses and
      // rules are mostly documented there, and Spanish keywords miss them.
      if (angles.length > 0 && ITALY.test(query)) angles.splice(1, 1, `prezzi costi servizi ${topic}`);
      const queries = [...new Set([topic, ...angles])].slice(0, MAX_SEARCHES_PER_STEP);
      queries.forEach((q, i) => add('web.search', i === 0 ? 'Consultar fuentes actuales.' : `Buscar fuentes: ${q.slice(0, 60)}`, false, { query: q.slice(0, 300), limit: 5 }, i === 0 ? '' : `#${i + 1}`));
    }
    if (capability.startsWith('research.') && agent.optionalTools.includes('web.fetch')) {
      urls.slice(0, 2).forEach((url, i) => add('web.fetch', 'Leer la página que el usuario indicó.', false, { url }, `#${i + 1}`));
    }
    if (capability.startsWith('research.') && agent.optionalTools.includes('news.gdelt')) {
      add('news.gdelt', 'Ver qué se publica ahora sobre el tema.', false, { query: topicText || keywords(query, 6) || query.slice(0, 80), limit: 8 });
    }
    if (capability.startsWith('research.') && agent.optionalTools.includes('research.wikipedia')) {
      add('research.wikipedia', 'Contexto enciclopédico con fuente citable.', false, { title: query.slice(0, 150) });
    }
    if (capability.startsWith('finance.') && agent.optionalTools.includes('math.calculator')) {
      add('math.calculator', 'Comprobar las cuentas.', false, null);
    }
    return requests;
  }

  // ---- gaps ----------------------------------------------------------------

  private gapFor(capability: Capability, blocking: boolean): CapabilityGap {
    const planned = this.agents.plannedFor(capability).map((a) => a.id);
    const tools = this.tools.anyFor(capability).map((t) => t.id);
    return {
      capability,
      reason: `Ningún agente activo cubre «${describeCapability(capability)}».`,
      needs: unique([...planned, ...tools]),
      blocking,
    };
  }

  /** A gap for a wanted capability, or null when an active agent or a usable tool provides it. */
  private gapForCapability(capability: Capability): CapabilityGap | null {
    if (this.agents.forCapability(capability).length > 0) return null;
    if (this.tools.forCapability(capability).length > 0) return null;
    const anyTool = this.tools.anyFor(capability);
    const plannedAgents = this.agents.plannedFor(capability);
    const notes: string[] = [];
    if (anyTool.length > 0) notes.push(`herramienta no conectada: ${anyTool.map((t) => t.id).join(', ')}`);
    if (plannedAgents.length > 0) notes.push(`agente no activo: ${plannedAgents.map((a) => a.id).join(', ')}`);
    return {
      capability,
      reason: `${describeCapability(capability)} — ${notes.length > 0 ? notes.join('; ') : 'nada en esta versión lo proporciona'}.`,
      needs: unique([...plannedAgents.map((a) => a.id), ...anyTool.map((t) => t.id)]),
      blocking: false,
    };
  }
}

/** What a retrieval tool should look for on behalf of one task: the mission's subject plus the task's own title. */
const MAX_SEARCHES_PER_STEP = 3;

/**
 * What the mission is about, as search words: the keywords of its FIRST sentence.
 * Later sentences hold instructions ("investiga…", "tengo 1.500 €"), which make
 * terrible search terms.
 */
function topicOf(compiled: CompiledMission): string {
  const first = compiled.intent.rawText.replace(/https?:\/\/\S+/g, ' ').split(/(?<=[.!?])\s+/)[0] ?? '';
  return keywords(first, 6);
}
const ITALY = /\b(italia|italy|italiano|italiana|tur[ií]n|torino|mil[aá]n|milano|roma|n[aá]poles|napoli|bolo[nñ]ia|bologna|florencia|firenze|venecia|venezia|g[eé]nova|genova)\b/i;

/** Addresses the user wrote in the mission, which they clearly want read. */
function urlsIn(compiled: CompiledMission): string[] {
  const text = [compiled.intent.rawText, compiled.objective.text, ...compiled.context.map((s) => s.text)].join(' ');
  return [...new Set(text.match(/https?:\/\/[^\s<>"')\]»«“”]+/gi) ?? [])].map((u) => u.replace(/[.,;:!?]+$/, ''));
}

/** Extra angles to search for, by the kind of research the step does. */
const SEARCH_ANGLES: Partial<Record<string, string[]>> = {
  'research.competitors': ['competidores alternativas', 'precios tarifas'],
  'research.market': ['mercado tamaño demanda', 'precios tarifas'],
  'research.regulatory': ['normativa requisitos licencias', 'costes trámites'],
  'research.audience': ['clientes perfil demanda', 'opiniones problemas'],
};

function searchQuery(compiled: CompiledMission, task: MissionTask): string {
  const subject = compiled.intent.subject ?? compiled.objective.text;
  return `${subject} ${task.title}`.replace(/\s+/g, ' ').trim().slice(0, 300);
}

function dedupeGaps(gaps: readonly CapabilityGap[]): CapabilityGap[] {
  const seen = new Map<string, CapabilityGap>();
  for (const gap of gaps) if (!seen.has(gap.capability)) seen.set(gap.capability, gap);
  return [...seen.values()];
}

/**
 * Waves of steps that could run together: every step in a wave has all its
 * dependencies in earlier waves. Cycles are impossible from the templates but
 * are guarded anyway (the remainder is emitted as a last wave).
 */
export function computeWaves(steps: readonly MissionStep[]): string[][] {
  const ids = new Set(steps.map((s) => s.id));
  const done = new Set<string>();
  const waves: string[][] = [];
  let remaining = [...steps];

  while (remaining.length > 0) {
    const wave = remaining.filter((s) => s.dependsOn.every((d) => !ids.has(d.stepId) || done.has(d.stepId)));
    if (wave.length === 0) {
      waves.push(remaining.map((s) => s.id));
      break;
    }
    waves.push(wave.map((s) => s.id));
    for (const s of wave) done.add(s.id);
    remaining = remaining.filter((s) => !done.has(s.id));
  }
  return waves;
}

/** Validate a plan's structure. Returns problems; an empty list means it is sound. */
export function validatePlan(plan: MissionPlan): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const step of plan.steps) {
    if (ids.has(step.id)) problems.push(`Duplicate step id ${step.id}.`);
    ids.add(step.id);
  }
  for (const step of plan.steps) {
    for (const dep of step.dependsOn) {
      if (!ids.has(dep.stepId)) problems.push(`${step.id} depends on unknown step ${dep.stepId}.`);
      if (dep.stepId === step.id) problems.push(`${step.id} depends on itself.`);
    }
  }
  const scheduled = plan.parallelGroups.flat();
  if (scheduled.length !== plan.steps.length) problems.push('Waves do not cover every step exactly once.');
  return problems;
}

export { taskIdFor };
