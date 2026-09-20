/**
 * Cost controller.
 *
 * Records what every model or tool call cost, and answers "may this call go
 * ahead?" against per-mission, daily, monthly, per-agent and per-tool budgets.
 *
 * MADRE never guesses a price. A call to a provider with no configured price is
 * recorded as *unpriced*; totals say how many calls were unpriced so nobody
 * mistakes a lower bound for the true figure. Local and simulated providers are
 * free by definition.
 *
 * Besides blocking, `check()` warns: any ceiling the call does NOT cross but
 * comes close to comes back as a `BudgetAlert`. An alert is information, never
 * a veto.
 */

import { newId } from '@acc/domain';

import { KINDS, type MadreStore } from '../store.ts';
import type { Budget, BudgetAlert, BudgetCheck, CostRecord, CostSummary } from '../types.ts';
import { round } from '../util.ts';

export interface PriceEntry {
  inputPer1kUsd: number;
  outputPer1kUsd: number;
}

/** Keys are `provider` or `provider:model`; the most specific wins. */
export type PriceTable = Record<string, PriceEntry>;

export const FREE_PROVIDERS: ReadonlySet<string> = new Set(['mock', 'ollama']);

/**
 * Warn once four fifths of a ceiling are committed.
 *
 * Low enough that a mission still has room for a step or two after the warning
 * — so the operator can react instead of just reading the obituary — and high
 * enough that a normal run does not spend its whole life under a warning.
 */
export const DEFAULT_ALERT_AT_FRACTION = 0.8;

export const NO_BUDGET: Budget = {
  perMissionUsd: null,
  dailyUsd: null,
  monthlyUsd: null,
  perAgentUsd: {},
  perToolUsd: {},
  alertAtFraction: DEFAULT_ALERT_AT_FRACTION,
  onExceed: 'block',
};

export interface RecordCallInput {
  missionId?: string | null;
  runId?: string | null;
  stepId?: string | null;
  agentId?: string | null;
  kind?: 'model' | 'tool';
  /** For a tool call this is the tool id; `byTool` and `perToolUsd` key on it. */
  provider: string;
  model?: string | null;
  promptTokens?: number;
  completionTokens?: number;
  /** What the vendor actually charged, when it reports it. Wins over the estimate. */
  actualUsd?: number | null;
  latencyMs?: number;
  /** `real` or `mock`, for the ledger. */
  source?: 'real' | 'mock';
  /** The provider's request id for the call. */
  requestId?: string | null;
}

export interface CheckInput {
  missionId: string;
  agentId?: string | null;
  providerId: string;
  /**
   * The tool this call runs, when it is a tool call. `providerId` stays the
   * thing being billed (for a tool call the caller passes the tool id in both),
   * and this field is what `perToolUsd` is looked up by.
   */
  toolId?: string | null;
  estimatedUsd: number | null;
}

/** One budget ceiling in play for a single `check()`. */
interface Ceiling {
  scope: BudgetAlert['scope'];
  subject: string | null;
  limitUsd: number;
  /** Spent against this ceiling before the call being checked. */
  spentUsd: number;
}

export class CostController {
  constructor(
    private readonly store: MadreStore,
    private budget: Budget = NO_BUDGET,
    private readonly prices: PriceTable = {},
  ) {}

  getBudget(): Budget {
    return { ...this.budget, perAgentUsd: { ...this.budget.perAgentUsd }, perToolUsd: { ...this.budget.perToolUsd } };
  }

  setBudget(budget: Budget): void {
    this.budget = { ...budget, perAgentUsd: { ...budget.perAgentUsd }, perToolUsd: { ...budget.perToolUsd } };
  }

  /** Estimated USD for a call, or null when the price is unknown. */
  estimate(provider: string, model: string | null, promptTokens: number, completionTokens: number): number | null {
    if (FREE_PROVIDERS.has(provider)) return 0;
    const price = (model !== null ? this.prices[`${provider}:${model}`] : undefined) ?? this.prices[provider];
    if (price === undefined) return null;
    return round((promptTokens / 1000) * price.inputPer1kUsd + (completionTokens / 1000) * price.outputPer1kUsd, 6);
  }

  async record(input: RecordCallInput): Promise<CostRecord> {
    const promptTokens = input.promptTokens ?? 0;
    const completionTokens = input.completionTokens ?? 0;
    const record: CostRecord = {
      id: newId(),
      at: this.store.clock.now().toISOString(),
      missionId: input.missionId ?? null,
      runId: input.runId ?? null,
      stepId: input.stepId ?? null,
      agentId: input.agentId ?? null,
      kind: input.kind ?? 'model',
      provider: input.provider,
      model: input.model ?? null,
      promptTokens,
      completionTokens,
      // Tools are not token-priced, and MADRE invents no price for them: the
      // record stays unpriced unless the caller reports what it really cost.
      estimatedUsd:
        input.kind === 'tool' ? null : this.estimate(input.provider, input.model ?? null, promptTokens, completionTokens),
      actualUsd: input.actualUsd ?? null,
      latencyMs: input.latencyMs ?? 0,
      ...(input.source !== undefined ? { source: input.source } : {}),
      ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
    };
    await this.store.put(KINDS.cost, record.id, record, { missionId: record.missionId, runId: record.runId });
    return record;
  }

  async summary(filter: { missionId?: string; runId?: string } = {}): Promise<CostSummary> {
    const records = await this.store.list<CostRecord>(KINDS.cost, { ...filter, order: 'asc' });
    return summarize(records);
  }

  /** May a call costing about `estimatedUsd` go ahead? */
  async check(input: CheckInput): Promise<BudgetCheck> {
    const b = this.budget;
    const now = this.store.clock.now();
    const all = await this.store.list<CostRecord>(KINDS.cost, { order: 'desc', limit: 5000 });

    const spent = (predicate: (r: CostRecord) => boolean): number =>
      round(all.filter(predicate).reduce((sum, r) => sum + knownUsd(r), 0), 6);

    const day = now.toISOString().slice(0, 10);
    const month = now.toISOString().slice(0, 7);
    const missionSpent = spent((r) => r.missionId === input.missionId);
    const dailySpent = spent((r) => r.at.startsWith(day));
    const monthlySpent = spent((r) => r.at.startsWith(month));

    const remaining = {
      mission: b.perMissionUsd === null ? null : round(b.perMissionUsd - missionSpent, 6),
      daily: b.dailyUsd === null ? null : round(b.dailyUsd - dailySpent, 6),
      monthly: b.monthlyUsd === null ? null : round(b.monthlyUsd - monthlySpent, 6),
    };

    // Per-agent and per-tool ceilings are scoped to the mission, the way an
    // operator reads them: "this agent may spend X on this mission".
    const ceilings: Ceiling[] = [];
    if (b.perMissionUsd !== null) {
      ceilings.push({ scope: 'mission', subject: null, limitUsd: b.perMissionUsd, spentUsd: missionSpent });
    }
    if (b.dailyUsd !== null) ceilings.push({ scope: 'daily', subject: null, limitUsd: b.dailyUsd, spentUsd: dailySpent });
    if (b.monthlyUsd !== null) {
      ceilings.push({ scope: 'monthly', subject: null, limitUsd: b.monthlyUsd, spentUsd: monthlySpent });
    }
    const agentLimit = input.agentId != null ? b.perAgentUsd[input.agentId] : undefined;
    if (input.agentId != null && agentLimit !== undefined) {
      ceilings.push({
        scope: 'agent',
        subject: input.agentId,
        limitUsd: agentLimit,
        spentUsd: spent((r) => r.missionId === input.missionId && r.agentId === input.agentId),
      });
    }
    const toolLimit = input.toolId != null ? b.perToolUsd[input.toolId] : undefined;
    if (input.toolId != null && toolLimit !== undefined) {
      ceilings.push({
        scope: 'tool',
        subject: input.toolId,
        limitUsd: toolLimit,
        spentUsd: spent((r) => r.missionId === input.missionId && r.kind === 'tool' && r.provider === input.toolId),
      });
    }

    const alerts = (cost: number): BudgetAlert[] => nearAlerts(ceilings, cost, b.alertAtFraction);

    const exceed = (crossed: Ceiling, cost: number): BudgetCheck => ({
      allowed: false,
      reason: exceedReason(crossed),
      action: b.onExceed === 'block' ? 'block' : b.onExceed === 'ask' ? 'ask' : 'fallback_local',
      remainingUsd: remaining,
      // Other ceilings still deserve a warning even when this one blocks.
      alerts: alerts(cost),
    });

    // Free providers can never break a budget. They can still leave the mission
    // close to a ceiling, so the alerts are worth reporting.
    if (FREE_PROVIDERS.has(input.providerId)) {
      return { allowed: true, reason: null, action: 'proceed', remainingUsd: remaining, alerts: alerts(0) };
    }

    if (input.estimatedUsd === null) {
      // Never invent a price: with a budget in force an unpriced call is refused.
      if (ceilings.length > 0) {
        return {
          allowed: false,
          reason: `Se desconoce el precio de «${input.providerId}», así que no se puede comprobar el presupuesto.`,
          action: b.onExceed === 'block' ? 'block' : b.onExceed === 'ask' ? 'ask' : 'fallback_local',
          remainingUsd: remaining,
          alerts: alerts(0),
        };
      }
      return { allowed: true, reason: null, action: 'proceed', remainingUsd: remaining, alerts: [] };
    }

    const cost = input.estimatedUsd;
    const crossed = ceilings.find((c) => c.spentUsd + cost > c.limitUsd);
    if (crossed !== undefined) return exceed(crossed, cost);
    return { allowed: true, reason: null, action: 'proceed', remainingUsd: remaining, alerts: alerts(cost) };
  }
}

function exceedReason(ceiling: Ceiling): string {
  switch (ceiling.scope) {
    case 'mission':
      return `Esta llamada superaría el presupuesto de la misión, de ${money(ceiling.limitUsd)} USD.`;
    case 'daily':
      return `Esta llamada superaría el presupuesto diario, de ${money(ceiling.limitUsd)} USD.`;
    case 'monthly':
      return `Esta llamada superaría el presupuesto mensual, de ${money(ceiling.limitUsd)} USD.`;
    case 'agent':
      return `Esta llamada superaría el presupuesto del agente ${ceiling.subject}, de ${money(ceiling.limitUsd)} USD.`;
    case 'tool':
      return `Esta llamada superaría el presupuesto de la herramienta ${ceiling.subject}, de ${money(ceiling.limitUsd)} USD.`;
  }
}

/**
 * Ceilings the call stays inside but leaves at or past `alertAtFraction`.
 * The figures include the call being checked, because that is what the operator
 * is about to commit to.
 */
function nearAlerts(ceilings: readonly Ceiling[], cost: number, alertAtFraction: number | null): BudgetAlert[] {
  if (alertAtFraction === null) return [];
  const alerts: BudgetAlert[] = [];
  for (const ceiling of ceilings) {
    if (ceiling.limitUsd <= 0) continue;
    const projected = round(ceiling.spentUsd + cost, 6);
    if (projected > ceiling.limitUsd) continue; // Crossed, not near: that is a block, not a warning.
    const usedFraction = round(projected / ceiling.limitUsd, 6);
    if (usedFraction < alertAtFraction) continue;
    alerts.push({
      scope: ceiling.scope,
      subject: ceiling.subject,
      limitUsd: ceiling.limitUsd,
      spentUsd: projected,
      usedFraction,
      message: alertMessage(ceiling.scope, ceiling.subject, projected, ceiling.limitUsd, usedFraction),
    });
  }
  return alerts;
}

function alertMessage(
  scope: BudgetAlert['scope'],
  subject: string | null,
  spentUsd: number,
  limitUsd: number,
  usedFraction: number,
): string {
  const figures = `${money(spentUsd)} USD de los ${money(limitUsd)} USD disponibles (${percent(usedFraction)}).`;
  switch (scope) {
    case 'mission':
      return `Con esta llamada la misión alcanza ${figures}`;
    case 'daily':
      return `Con esta llamada el gasto de hoy alcanza ${figures}`;
    case 'monthly':
      return `Con esta llamada el gasto de este mes alcanza ${figures}`;
    case 'agent':
      return `Con esta llamada el agente ${subject} alcanza ${figures}`;
    case 'tool':
      return `Con esta llamada la herramienta ${subject} alcanza ${figures}`;
  }
}

/** USD with no trailing zero noise: 0.5, 1, 0.123456. */
function money(value: number): string {
  return String(round(value, 6));
}

function percent(fraction: number): string {
  return `${round(fraction * 100, 1)} %`;
}

function knownUsd(record: CostRecord): number {
  return record.actualUsd ?? record.estimatedUsd ?? 0;
}

export function summarize(records: readonly CostRecord[]): CostSummary {
  const summary: CostSummary = {
    calls: 0,
    promptTokens: 0,
    completionTokens: 0,
    knownUsd: 0,
    unpricedCalls: 0,
    latencyMs: 0,
    byProvider: {},
    byAgent: {},
    byTool: {},
  };
  for (const r of records) {
    summary.calls += 1;
    summary.promptTokens += r.promptTokens;
    summary.completionTokens += r.completionTokens;
    summary.latencyMs += r.latencyMs;
    // What the vendor charged, else the estimate. Never a guess: an unpriced
    // call adds nothing and is counted, so `knownUsd` reads as a lower bound
    // whenever `unpricedCalls` is above zero.
    const price = r.actualUsd ?? r.estimatedUsd;
    if (price === null) summary.unpricedCalls += 1;
    const usd = price ?? 0;
    summary.knownUsd += usd;
    const p = (summary.byProvider[r.provider] ??= { calls: 0, usd: 0 });
    p.calls += 1;
    p.usd = round(p.usd + usd, 6);
    if (r.agentId !== null) {
      const a = (summary.byAgent[r.agentId] ??= { calls: 0, usd: 0 });
      a.calls += 1;
      a.usd = round(a.usd + usd, 6);
    }
    // A tool call records the tool id in `provider`, so that is the key here.
    if (r.kind === 'tool') {
      const t = (summary.byTool[r.provider] ??= { calls: 0, usd: 0 });
      t.calls += 1;
      t.usd = round(t.usd + usd, 6);
    }
  }
  summary.knownUsd = round(summary.knownUsd, 6);
  return summary;
}

export function emptyCostSummary(): CostSummary {
  return summarize([]);
}
