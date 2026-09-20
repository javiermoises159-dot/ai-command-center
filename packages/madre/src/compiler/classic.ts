/**
 * Classic planner.
 *
 * The classic pipeline is the fixed, eight-agent sequence the product started
 * with: every specialist in catalog order, then QA, then the integrator. It used
 * to be run by its own orchestrator, outside MADRE, and so outside routing,
 * permissions, cost limits, the audit log, the trace and cancellation.
 *
 * It now runs on the same engine as every other mission. This planner is the
 * only thing that differs: instead of compiling the mission into tasks it lays
 * out the fixed sequence as a plan. Everything after that — routing, the tool
 * pipeline, cost control, the circuit breaker, persistence, recovery, cancel —
 * is the shared engine, so classic cannot skip a control the engine applies.
 *
 * What is deliberately different from a MADRE plan (see docs/MADRE.md):
 *  - the steps are the catalog's eight agents, always, in a strict order;
 *  - each step sees everything the earlier steps produced, as the classic
 *    pipeline always did (a soft dependency on every predecessor);
 *  - one attempt per step, no retries or provider fallbacks;
 *  - the provider is the one the mission was started with (the engine pins it);
 *  - no planned tool calls, and no judge-driven revision rounds.
 */

import { newId, pipelineOrder, type AgentDefinition } from '@acc/domain';

import type { AgentRegistry } from '../registry/agents.ts';
import type { AgentSpec, CapabilityGap, MissionPlan, MissionStep, StepDependency } from '../types.ts';
import { systemClock } from '../util.ts';
import { compileMission } from './compile.ts';
import { INTEGRATE_STEP_ID, QA_STEP_ID, computeWaves, type PlanOptions, type Planner } from './planner.ts';

export const CLASSIC_PLANNER_ID = 'classic-planner@1';

const classicStepId = (legacyId: string): string => `s-classic-${legacyId}`;

export class ClassicPlanner implements Planner {
  readonly id = CLASSIC_PLANNER_ID;

  constructor(
    private readonly agents: AgentRegistry,
    private readonly options: { continueOnWorkerFailure?: boolean } = {},
  ) {}

  plan(text: string, options: PlanOptions = {}): MissionPlan {
    const compiled = compileMission(text, { providedDocuments: options.providedDocuments ?? 1 });
    const clock = options.clock ?? systemClock;
    const gaps: CapabilityGap[] = [];
    const steps: MissionStep[] = [];
    const sensitive = compiled.intent.sensitivity.involvesPersonalData;

    const find = (definition: AgentDefinition): AgentSpec | undefined =>
      this.agents.active().find((a) => a.legacyAgentId === definition.id);

    const workerIds: string[] = [];
    for (const definition of pipelineOrder()) {
      const agent = find(definition);
      if (agent === undefined) {
        gaps.push({
          capability: definition.kind === 'qa' ? 'qa.review' : 'integration.brief',
          reason: `El agente «${definition.name}» del pipeline clásico no está activo en el registro de MADRE.`,
          needs: [definition.id],
          blocking: true,
        });
        continue;
      }
      const id = definition.kind === 'qa' ? QA_STEP_ID : definition.kind === 'integrator' ? INTEGRATE_STEP_ID : classicStepId(definition.id);
      // Everyone sees everything that ran before them, and runs after it, whether
      // or not it succeeded (soft). The integrator additionally needs QA (hard):
      // without an audit there is no deliverable, exactly as in the old pipeline.
      // `continueOnWorkerFailure: false` makes every dependency hard, so the first
      // failure blocks everything after it, as the old option did.
      const link = this.options.continueOnWorkerFailure === false ? 'hard' : 'soft';
      const dependsOn: StepDependency[] = workerIds.map((stepId) => ({ stepId, mode: link }));
      if (definition.kind === 'integrator' && steps.some((s) => s.id === QA_STEP_ID)) dependsOn.push({ stepId: QA_STEP_ID, mode: 'hard' });
      const capability = agent.capabilities[0] ?? 'strategy.positioning';
      steps.push({
        id,
        title: definition.name,
        kind: definition.kind === 'qa' ? 'qa' : definition.kind === 'integrator' ? 'integrate' : 'agent',
        agentId: agent.id,
        capability,
        dependsOn,
        task: {
          stepId: id,
          agentId: agent.id,
          instruction:
            definition.kind === 'worker'
              ? `Trabaja la misión desde el ángulo de ${definition.name}.`
              : definition.kind === 'qa'
                ? 'Audita todos los resultados de los especialistas producidos en esta ejecución.'
                : 'Unifica todos los resultados de los especialistas y la revisión de calidad en un único entregable.',
          expectedOutput: definition.deliverable,
          constraints: compiled.constraints.map((c) => c.text),
          requiredCapabilities: [capability],
          difficulty: 3,
          needsFreshInformation: false,
          sensitive,
        },
        toolRequests: [],
        verification: [],
        maxAttempts: 1,
      });
      if (definition.kind === 'worker') workerIds.push(id);
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
      gaps,
      warnings: [
        'Pipeline clásico: ocho agentes en orden fijo, un intento por paso, sin herramientas planificadas ni rondas de revisión. Pasa por el mismo enrutado, permisos, coste, auditoría y cancelación que cualquier misión.',
      ],
    };
  }
}
