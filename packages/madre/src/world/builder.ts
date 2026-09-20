/**
 * World model.
 *
 * A snapshot of what MADRE knows about itself and its situation: who the user
 * is (from memory), what is going on (missions, approvals), what it may and may
 * not do (budget, permissions), what it has to work with (providers, tools,
 * agents), what it cannot do yet, and what would be most useful next.
 *
 * Every line is derived from the registries and stores at the moment of the
 * call. Nothing is cached and nothing is asserted that the registries do not
 * say, so the model cannot drift from reality.
 */

import type { MissionRepository } from '@acc/domain';

import type { CostController } from '../cost/controller.ts';
import type { MemoryService } from '../memory/service.ts';
import type { ApprovalService } from '../permissions/approvals.ts';
import type { PermissionPolicy } from '../permissions/policy.ts';
import type { AgentRegistry } from '../registry/agents.ts';
import type { ProviderCatalog } from '../registry/providers.ts';
import type { ToolRegistry } from '../registry/tools.ts';
import type { WorldModel } from '../types.ts';
import type { Clock } from '../util.ts';

export interface WorldDeps {
  missions: Pick<MissionRepository, 'count' | 'list'>;
  memory: MemoryService;
  approvals: ApprovalService;
  agents: AgentRegistry;
  tools: ToolRegistry;
  providers: ProviderCatalog;
  policy: PermissionPolicy;
  cost: CostController;
  clock: Clock;
}

/** Spanish agreement: "1 agente" / "3 agentes". Never "1 agente(s)". */
function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export async function buildWorldModel(d: WorldDeps): Promise<WorldModel> {
  const [total, running, completed, failed, recent, pending, stats, preferences, projectEntries] = await Promise.all([
    d.missions.count(),
    d.missions.count({ status: 'running' }),
    d.missions.count({ status: 'completed' }),
    d.missions.count({ status: 'failed' }),
    d.missions.list({ limit: 8 }),
    d.approvals.pending(200),
    d.memory.stats(),
    d.memory.list({ type: 'preference', limit: 8 }),
    d.memory.list({ scope: 'project' }),
  ]);

  const agentList = d.agents.list();
  const active = agentList.filter((a) => a.status === 'active');
  const planned = agentList.filter((a) => a.status !== 'active');
  const toolCounts = d.tools.countByStatus();
  const providers = d.providers.profiles().filter((p) => p.tier !== 'specialized');
  const executable = providers.filter((p) => p.executable);
  const realExecutable = executable.filter((p) => p.status !== 'MOCK');
  const usableTools = d.tools.list().filter((t) => d.tools.isUsable(t.id));
  const waitingMissions = new Set(pending.map((a) => a.missionId));

  const gaps: string[] = [];
  if (realExecutable.length === 0) {
    gaps.push(
      executable.length > 0
        ? 'No hay ningún modelo real conectado: los agentes se ejecutan en el proveedor simulado, así que los resultados son simulaciones.'
        : 'Ningún proveedor puede ejecutar tareas.',
    );
  }
  if (d.tools.forCapability('research.web').length === 0) gaps.push('No hay búsqueda web conectada: la investigación usa solo el conocimiento del modelo y no puede verificar hechos actuales.');
  if (d.tools.get('sandbox.exec')?.status === 'DISABLED') gaps.push('La ejecución de código está desactivada a propósito hasta que se pueda aislar.');
  const publishers = d.tools.byCategory('distribution');
  if (publishers.every((t) => !d.tools.isUsable(t.id))) gaps.push('No hay ningún canal de publicación conectado: MADRE puede planificar contenido, pero no publicarlo.');
  if (planned.length > 0) {
    gaps.push(
      `${plural(planned.length, 'agente especialista está declarado pero no activo', 'agentes especialistas están declarados pero no activos')} (${planned
        .slice(0, 4)
        .map((a) => a.name)
        .join(', ')}${planned.length > 4 ? ', …' : ''}).`,
    );
  }

  const canDo: string[] = [
    'Convertir una misión en un plan contrastado, con lo que se sabe, lo que se supone y lo que falta por investigar.',
    `Ejecutar ${plural(active.length, 'agente especialista', 'agentes especialistas')} en orden de dependencias y revisar su trabajo de forma independiente.`,
  ];
  if (executable.length > 0) canDo.push(`Ejecutar pasos en: ${executable.map((p) => p.label).join(', ')}.`);
  canDo.push('Recordar y guardar información con su origen y su confianza.', 'Comprobar la aritmética de forma exacta.', 'Pararse a pedir aprobación antes de cualquier acción sensible.');
  if (usableTools.some((t) => t.id === 'sandbox.files')) canDo.push('Mantener los archivos temporales en un entorno aislado.');

  const next: string[] = [];
  if (realExecutable.length === 0) next.push('Conecta un modelo local (define OLLAMA_BASE_URL) para que los agentes produzcan análisis de verdad.');
  if (d.tools.forCapability('research.web').length === 0) next.push('Conecta una herramienta de búsqueda para que la investigación pueda citar fuentes actuales.');
  if (pending.length > 0) next.push(`Resuelve ${plural(pending.length, 'aprobación pendiente', 'aprobaciones pendientes')}.`);
  if (running === 0 && total === 0) next.push('Crea la primera misión.');
  if (stats.total === 0) next.push('Cuéntale a MADRE tu proyecto y tus preferencias para que las misiones arranquen con contexto.');

  return {
    generatedAt: d.clock.now().toISOString(),
    user: { memoryEntries: stats.total, preferences: preferences.map((p) => p.content).slice(0, 8) },
    projects: { entries: projectEntries.length },
    missions: { total, running, completed, failed, waiting: waitingMissions.size },
    agents: { active: active.length, planned: planned.length, total: agentList.length },
    tools: toolCounts,
    providers: {
      connected: providers.filter((p) => p.status === 'CONNECTED').length,
      local: providers.filter((p) => p.status === 'LOCAL').length,
      mock: providers.filter((p) => p.status === 'MOCK').length,
      notConnected: providers.filter((p) => p.status === 'NOT_CONNECTED').length,
      error: providers.filter((p) => p.status === 'ERROR').length,
    },
    knowledge: { entries: stats.total, verified: stats.verified, lessons: stats.lessons },
    constraints: { budget: d.cost.getBudget(), permissions: d.policy.configured() },
    resources: { executableProviders: executable.map((p) => p.id), usableTools: usableTools.map((t) => t.id) },
    goals: recent
      .filter(({ mission }) => mission.status === 'running' || mission.status === 'pending' || waitingMissions.has(mission.id))
      .map(({ mission }) => ({ title: mission.title, missionId: mission.id, status: waitingMissions.has(mission.id) ? 'waiting' : mission.status })),
    gaps,
    canDo,
    next,
  };
}
