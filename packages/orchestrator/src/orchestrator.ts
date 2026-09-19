/**
 * MissionOrchestrator — executes one run, one agent at a time.
 *
 * It depends only on ports (`Repositories`, `AIProvider` via the registry,
 * `Clock`, `Logger`). It never imports a vendor SDK, an ORM, or Express, which
 * is why it can be tested in full with in-memory adapters.
 *
 * Failure policy
 * --------------
 * A WORKER failure (Strategy…Finance) is survivable: the agent is marked
 * `failed`, the run continues, and QA and the Integrator are told what is
 * missing so the brief documents its own gap.
 *
 * A QA or INTEGRATOR failure aborts the run: without an audit or a merge there
 * is no deliverable, so remaining agents are marked `skipped` rather than left
 * `pending` forever.
 *
 * A run finishes `completed` only when every agent completed. If anything
 * failed, the run and the mission are `failed` — even when the Integrator still
 * produced a usable brief, which is stored so the partial work is not lost.
 */

import {
  ProviderTimeoutError,
  errorMessage,
  getAgentDefinition,
  systemClock,
  toDomainError,
  type AgentExecution,
  type Clock,
  type FailedAgent,
  type Logger,
  type MissionRun,
  type ProviderTask,
  type Repositories,
  type RunId,
  type UpstreamResult,
} from '@acc/domain';
import type { ProviderRegistry } from '@acc/providers';
import { renderPrompt } from './prompts.ts';

export interface OrchestratorOptions {
  /** Keep executing remaining agents after a worker agent fails. */
  continueOnWorkerFailure?: boolean;
  /** Per-agent wall-clock budget. */
  agentTimeoutMs?: number;
}

export interface RunOutcome {
  runId: RunId;
  status: 'completed' | 'failed';
  completedAgents: number;
  failedAgents: number;
  skippedAgents: number;
  finalResult: string | null;
}

export class MissionOrchestrator {
  private readonly repos: Repositories;
  private readonly providers: ProviderRegistry;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly continueOnWorkerFailure: boolean;
  private readonly agentTimeoutMs: number;

  constructor(deps: {
    repositories: Repositories;
    providers: ProviderRegistry;
    logger: Logger;
    clock?: Clock;
    options?: OrchestratorOptions;
  }) {
    this.repos = deps.repositories;
    this.providers = deps.providers;
    this.logger = deps.logger.child({ component: 'orchestrator' });
    this.clock = deps.clock ?? systemClock;
    this.continueOnWorkerFailure = deps.options?.continueOnWorkerFailure ?? true;
    this.agentTimeoutMs = deps.options?.agentTimeoutMs ?? 60_000;
  }

  /**
   * Execute a run to completion. Never throws for agent-level problems — those
   * are recorded on the rows. It only throws if the run itself cannot be
   * driven (missing run, unusable provider), and even then it marks the run
   * failed first so nothing is left stuck in `running`.
   */
  async execute(runId: RunId): Promise<RunOutcome> {
    const log = this.logger.child({ runId });
    const run = await this.repos.runs.findById(runId);
    if (!run) throw new Error(`Run ${runId} disappeared before execution.`);

    const mission = await this.repos.missions.findById(run.missionId);
    if (!mission) throw new Error(`Mission ${run.missionId} disappeared before execution.`);

    try {
      return await this.drive(run, mission.prompt, log);
    } catch (error) {
      // Infrastructure-level failure: close the run honestly instead of
      // leaving it `running` for a poller that will never see it change.
      const at = this.clock.now();
      const message = errorMessage(error);
      log.error('run aborted by infrastructure error', { error: message });
      await this.repos.agents.markRemainingSkipped(run.id, at);
      await this.repos.runs.markFinished(run.id, 'failed', at, { error: message });
      await this.repos.missions.updateStatus(run.missionId, 'failed', at);
      throw toDomainError(error);
    }
  }

  private async drive(run: MissionRun, missionPrompt: string, log: Logger): Promise<RunOutcome> {
    const { provider, model } = this.providers.resolve(run.providerId, run.model);

    await this.repos.runs.markStarted(run.id, this.clock.now());
    await this.repos.missions.updateStatus(run.missionId, 'running', this.clock.now());

    const agents = await this.repos.agents.listByRun(run.id);
    const upstream: UpstreamResult[] = [];
    const failed: FailedAgent[] = [];

    let aborted = false;
    let finalResult: string | null = null;
    let completedCount = 0;

    for (const agent of agents) {
      const definition = getAgentDefinition(agent.agentId);
      if (!definition) {
        // The catalog changed under a historical run. Record it, do not crash.
        await this.repos.agents.markFailed(
          agent.id,
          `Agent "${agent.agentId}" is no longer in the catalog.`,
          this.clock.now(),
        );
        failed.push({ agentId: agent.agentId, name: agent.name, error: 'Agent definition removed from catalog.' });
        continue;
      }

      await this.repos.agents.markStarted(agent.id, this.clock.now());
      log.debug('agent started', { agentId: agent.agentId });

      const task: ProviderTask = {
        agentId: agent.agentId,
        systemPrompt: definition.systemPrompt,
        prompt: renderPrompt({ agent: definition, missionPrompt, upstream, failed }),
        context: { missionPrompt, upstream: [...upstream], failed: [...failed] },
        model,
        metadata: { runId: run.id, missionId: run.missionId, agentExecutionId: agent.id },
      };

      try {
        const result = await this.callWithTimeout(provider.id, () => provider.execute(task, this.signal()));

        await this.repos.agents.markCompleted(
          agent.id,
          result.text,
          {
            provider: result.provider,
            model: result.model,
            requestId: result.requestId,
            promptTokens: result.usage.promptTokens,
            completionTokens: result.usage.completionTokens,
            totalTokens: result.usage.totalTokens,
            latencyMs: result.latencyMs,
          },
          this.clock.now(),
        );

        completedCount += 1;
        upstream.push({ agentId: agent.agentId, name: agent.name, result: result.text });
        if (definition.kind === 'integrator') finalResult = result.text;
        log.debug('agent completed', { agentId: agent.agentId, latencyMs: result.latencyMs });
      } catch (error) {
        const message = errorMessage(error);
        await this.repos.agents.markFailed(agent.id, message, this.clock.now());
        failed.push({ agentId: agent.agentId, name: agent.name, error: message });
        log.warn('agent failed', { agentId: agent.agentId, error: message });

        const survivable = definition.kind === 'worker' && this.continueOnWorkerFailure;
        if (!survivable) {
          aborted = true;
          break;
        }
      }
    }

    const at = this.clock.now();
    const skipped = aborted ? await this.repos.agents.markRemainingSkipped(run.id, at) : 0;

    const status: 'completed' | 'failed' = failed.length === 0 ? 'completed' : 'failed';

    await this.repos.runs.markFinished(run.id, status, at, {
      finalResult,
      error:
        failed.length === 0
          ? null
          : `${failed.length} agent${failed.length === 1 ? '' : 's'} failed: ${failed.map((f) => f.name).join(', ')}.`,
    });

    // The mission carries the latest run's deliverable, even a partial one:
    // losing the Integrator's work because a worker failed helps nobody.
    await this.repos.missions.setFinalResult(run.missionId, finalResult, status, at);

    log.info('run finished', { status, completed: completedCount, failed: failed.length, skipped });

    return {
      runId: run.id,
      status,
      completedAgents: completedCount,
      failedAgents: failed.length,
      skippedAgents: skipped,
      finalResult,
    };
  }

  private signal(): AbortSignal {
    return AbortSignal.timeout(this.agentTimeoutMs);
  }

  /**
   * `AbortSignal.timeout` aborts the provider, but adapters report an abort in
   * their own words. This normalises the message so the UI says "timed out"
   * rather than "cancelled".
   */
  private async callWithTimeout<T>(providerId: string, call: () => Promise<T>): Promise<T> {
    const startedAt = Date.now();
    try {
      return await call();
    } catch (error) {
      if (Date.now() - startedAt >= this.agentTimeoutMs) {
        throw new ProviderTimeoutError(providerId, this.agentTimeoutMs);
      }
      throw error;
    }
  }
}

/** Convenience for read models that need the ordered agent list of a run. */
export function orderAgents(agents: readonly AgentExecution[]): AgentExecution[] {
  return [...agents].sort((a, b) => a.orderIndex - b.orderIndex);
}
