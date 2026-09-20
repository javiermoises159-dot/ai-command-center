/**
 * Legacy mirror.
 *
 * A MADRE run still owns one `mission_agents` row per catalog agent, created
 * when the run was started, so every existing screen, endpoint and test keeps
 * working. The mirror keeps those rows honest as steps progress.
 *
 * Status mapping (many steps can belong to one agent):
 *   any step RUNNING or RETRYING   → running
 *   every step settled, none FAILED → completed
 *   any step FAILED                 → failed
 *   nothing started / only blocked  → pending (skipped when the run closes)
 *
 * The legacy repository only moves forward (pending → running → completed or
 * failed), so a later revision of an already-completed agent is not written to
 * its row. The MADRE run state is the source of truth for revisions.
 */

import type { AgentExecution, AgentExecutionRepository, AgentUsage, Clock } from '@acc/domain';

import type { AgentRegistry } from '../registry/agents.ts';
import type { MissionPlan, MadreRunState, StepState } from '../types.ts';

export interface LegacyMirror {
  /** Load the run's rows. Call once before `sync`. */
  attach(runId: string): Promise<void>;
  sync(plan: MissionPlan, state: MadreRunState): Promise<void>;
  /** Row id mirrored by an agent, when there is one. */
  executionIdFor(agentId: string): string | null;
  /** Close whatever never ran. */
  finalize(runId: string): Promise<void>;
}

/** Spanish agreement: "1 paso" / "3 pasos". Never "1 paso(s)". */
function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export class RepositoryMirror implements LegacyMirror {
  private rows = new Map<string, AgentExecution>();
  private applied = new Map<string, AgentExecution['status']>();

  constructor(
    private readonly agents: AgentRegistry,
    private readonly repo: AgentExecutionRepository,
    private readonly clock: Clock,
  ) {}

  async attach(runId: string): Promise<void> {
    this.rows.clear();
    this.applied.clear();
    for (const row of await this.repo.listByRun(runId)) {
      this.rows.set(row.agentId, row);
      this.applied.set(row.agentId, row.status);
    }
  }

  executionIdFor(agentId: string): string | null {
    const legacy = this.agents.get(agentId)?.legacyAgentId;
    return legacy != null ? (this.rows.get(legacy)?.id ?? null) : null;
  }

  async sync(plan: MissionPlan, state: MadreRunState): Promise<void> {
    const byLegacy = new Map<string, { title: string; state: StepState }[]>();
    for (const step of plan.steps) {
      const legacy = this.agents.get(step.agentId)?.legacyAgentId;
      if (legacy == null) continue;
      const st = state.steps.find((s) => s.stepId === step.id);
      if (st === undefined) continue;
      const list = byLegacy.get(legacy) ?? [];
      list.push({ title: step.title, state: st });
      byLegacy.set(legacy, list);
    }

    for (const [legacyId, group] of byLegacy) {
      const row = this.rows.get(legacyId);
      if (row === undefined) continue;
      const current = this.applied.get(legacyId) ?? row.status;
      if (current === 'completed' || current === 'failed' || current === 'skipped') continue;

      const active = group.some((g) => g.state.status === 'RUNNING' || g.state.status === 'RETRYING');
      const settled = group.every((g) => ['DONE', 'FAILED', 'BLOCKED', 'CANCELLED'].includes(g.state.status));
      const anyFailed = group.some((g) => g.state.status === 'FAILED');
      const anyDone = group.some((g) => g.state.status === 'DONE');
      const touched = active || group.some((g) => g.state.status === 'DONE' || g.state.status === 'FAILED');

      const at = this.clock.now();
      if (touched && current === 'pending') {
        await this.repo.markStarted(row.id, at);
        this.applied.set(legacyId, 'running');
      }
      if (active || !settled || !(anyDone || anyFailed)) continue;

      if (anyFailed || group.some((g) => g.state.status === 'BLOCKED' || g.state.status === 'CANCELLED')) {
        const problems = group
          .filter((g) => g.state.status !== 'DONE')
          .map((g) => `${g.title}: ${g.state.error ?? g.state.blockedReason ?? g.state.status.toLowerCase()}`);
        await this.repo.markFailed(
          row.id,
          `${problems.length} de ${plural(group.length, 'paso', 'pasos')} no ${problems.length === 1 ? 'llegó' : 'llegaron'} a terminar. ${problems.join(' | ')}`,
          at,
        );
        this.applied.set(legacyId, 'failed');
      } else {
        const done = group.filter((g) => g.state.result !== null);
        const text =
          done.length === 1
            ? done[0]!.state.result!.text
            : done.map((g) => `### ${g.title}\n\n${g.state.result!.text}`).join('\n\n');
        await this.repo.markCompleted(row.id, text, aggregateUsage(done.map((g) => g.state)), at);
        this.applied.set(legacyId, 'completed');
      }
    }
  }

  async finalize(runId: string): Promise<void> {
    const at = this.clock.now();
    // A row left running would show a spinner forever on a closed run.
    for (const [legacyId, row] of this.rows) {
      if (this.applied.get(legacyId) === 'running') {
        await this.repo.markFailed(row.id, 'La ejecución terminó antes de que este agente acabara.', at);
        this.applied.set(legacyId, 'failed');
      }
    }
    await this.repo.markRemainingSkipped(runId, at);
  }
}

function aggregateUsage(states: readonly StepState[]): AgentUsage {
  const results = states.flatMap((s) => (s.result !== null ? [s.result] : []));
  const first = results[0];
  const promptTokens = results.reduce((n, r) => n + r.promptTokens, 0);
  const completionTokens = results.reduce((n, r) => n + r.completionTokens, 0);
  return {
    provider: first?.provider ?? 'none',
    model: first?.model ?? 'none',
    requestId: first?.requestId ?? 'none',
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    latencyMs: results.reduce((n, r) => n + r.latencyMs, 0),
  };
}
