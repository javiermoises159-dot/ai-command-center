/**
 * Mission trace: mission → agent → model → tool → input → output → retry →
 * approval → cost → QA → final result, in one readable chain.
 *
 * The trace is a **view**, never a new store. Everything here is assembled from
 * records MADRE already writes — the plan, the run state, the QA rounds, the
 * cost ledger, the approvals and the audit log — so it cannot drift from what
 * actually happened. Nothing is inferred to fill a hole: a field nobody records
 * stays `null` or empty.
 *
 * `buildTrace` is pure. It takes the documents already read and returns the
 * trace, so the correlation rules can be tested without a database.
 */

import { summarize } from '../cost/controller.ts';
import { provenanceOf } from '../util.ts';
import type {
  ApprovalRequest,
  AuditEvent,
  CostRecord,
  MadreRunState,
  MissionPlan,
  MissionStep,
  MissionTrace,
  ProviderCallTrace,
  ProviderErrorCode,
  ProviderErrorInfo,
  QAIssue,
  QAResult,
  ResultSource,
  StepState,
  TraceStep,
} from '../types.ts';

/** The documents a trace is assembled from. All of them are already persisted. */
export interface TraceSources {
  missionId: string;
  runId: string;
  /** The plan gives each step its title and its place in the order. */
  plan: MissionPlan | null;
  state: MadreRunState;
  /** QA rounds stored on their own. Merged with the ones held in the run state. */
  qaRounds?: readonly QAResult[];
  /** Cost ledger entries for the run, model and tool calls alike. */
  costs?: readonly CostRecord[];
  approvals?: readonly ApprovalRequest[];
  audit?: readonly AuditEvent[];
}

/**
 * Assemble the trace of one run.
 *
 * Steps follow the plan's order; a plan step that never reached execution (no
 * `StepState`) is left out rather than shown with an invented status.
 */
export function buildTrace(sources: TraceSources): MissionTrace {
  const { missionId, runId, plan, state } = sources;
  const costs = sources.costs ?? [];
  const approvals = sources.approvals ?? [];
  const audit = sources.audit ?? [];

  const rounds = mergeQaRounds(sources.qaRounds ?? [], state.qaRounds);
  const issuesByStep = groupQaIssues(rounds);
  const costsByStep = groupBy(costs, (record) => record.stepId);
  const auditByStep = groupBy(audit, (event) => event.stepId);
  const approvalsByStep = groupBy(approvals, (approval) => approval.stepId);
  const planSteps = new Map<string, MissionStep>((plan?.steps ?? []).map((step) => [step.id, step]));
  const states = new Map<string, StepState>(state.steps.map((s) => [s.stepId, s]));

  const order = [...planSteps.keys(), ...state.steps.map((s) => s.stepId)];
  const seen = new Set<string>();
  const steps: TraceStep[] = [];
  for (const stepId of order) {
    if (seen.has(stepId)) continue;
    seen.add(stepId);
    const stepState = states.get(stepId);
    if (stepState === undefined) continue;
    steps.push(
      traceStep(
        stepState,
        planSteps.get(stepId),
        costsByStep.get(stepId) ?? [],
        issuesByStep.get(stepId) ?? [],
        stepApprovals(stepState, approvalsByStep.get(stepId) ?? [], approvals),
        auditByStep.get(stepId) ?? [],
      ),
    );
  }

  return {
    missionId,
    runId,
    phase: state.phase,
    objective: plan?.compiled.objective.text ?? '',
    steps,
    qaRounds: rounds.map((round) => ({ verdict: round.verdict, scope: round.stage, round: round.round, issues: round.issues.length })),
    cost: summarize(costs),
    events: [...audit]
      .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
      .map((event) => ({ at: event.at, type: event.type, message: event.message, stepId: event.stepId, data: event.data ?? null })),
    startedAt: state.startedAt,
    completedAt: state.completedAt,
    mode: state.mode ?? 'madre',
    recovery: state.recovery ?? null,
  };
}

function traceStep(
  state: StepState,
  step: MissionStep | undefined,
  costs: readonly CostRecord[],
  issues: readonly QAIssue[],
  approvals: readonly ApprovalRequest[],
  events: readonly AuditEvent[],
): TraceStep {
  const result = state.result;
  const routing = state.routing;
  const spend = summarize(costs);
  const provenance = result === null ? null : provenanceOf(result);
  return {
    stepId: state.stepId,
    title: step?.title ?? state.stepId,
    agentId: step?.agentId ?? result?.agentId ?? routing?.agentId ?? '',
    status: state.status,
    attempts: state.attempts,
    // What actually ran wins over what the router picked: after a route switch
    // the decision would otherwise name a model that never answered.
    provider: result?.provider ?? routing?.provider?.id ?? null,
    model: result?.model ?? routing?.provider?.model ?? null,
    execution: routing?.execution ?? null,
    routingRationale: routing?.rationale ?? [],
    // The step's own record of every call wins: a step that ended FAILED or
    // BLOCKED has no result, but its refused tool calls are still on the state.
    tools: (state.toolResults ?? result?.toolResults ?? []).map((tool) => ({
      toolId: tool.toolId,
      ok: tool.ok,
      verified: tool.verified,
      error: tool.error,
      stage: tool.stage ?? null,
      code: tool.code ?? null,
    })),
    // Known spend only. `unpricedCalls > 0` marks the figure as a lower bound.
    costUsd: costs.length > 0 ? spend.knownUsd : (result?.costUsd ?? null),
    unpricedCalls: spend.unpricedCalls,
    latencyMs: result?.latencyMs ?? (costs.length > 0 ? spend.latencyMs : null),
    startedAt: state.startedAt,
    completedAt: state.completedAt,
    error: state.error ?? state.blockedReason ?? result?.error ?? null,
    qaIssues: issues.map((issue) => ({ category: issue.category, severity: issue.severity, message: issue.message })),
    approvals: approvals.map((a) => ({ id: a.id, kind: a.kind, status: a.status, title: a.title })),
    outputChars: result === null ? null : result.text.length,
    source: provenance?.source ?? null,
    simulated: provenance?.simulated ?? null,
    requestId: result?.requestId ?? null,
    router: routing?.explanation ?? null,
    providerCalls: providerCalls(events),
    providerError: state.providerError ?? null,
  };
}

/**
 * Rebuild the calls a step made from the audit log: each `request_started`
 * opens one and the next `request_succeeded` / `request_failed` closes it. A
 * call with no closing event (the process died mid-call) stays `in_flight`
 * rather than being assumed to have finished.
 */
function providerCalls(events: readonly AuditEvent[]): ProviderCallTrace[] {
  const calls: ProviderCallTrace[] = [];
  let open: ProviderCallTrace | null = null;
  const ordered = [...events].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  for (const event of ordered) {
    const data = event.data ?? {};
    if (event.type === 'provider.request_started') {
      open = {
        attempt: num(data['attempt']) ?? calls.length + 1,
        provider: str(data['provider']) ?? '',
        model: str(data['model']) ?? '',
        startedAt: event.at,
        endedAt: null,
        latencyMs: null,
        outcome: 'in_flight',
        requestId: null,
        source: null,
        simulated: null,
        promptTokens: null,
        completionTokens: null,
        error: null,
      };
      calls.push(open);
    } else if (event.type === 'provider.request_succeeded' && open !== null) {
      open.endedAt = event.at;
      open.outcome = 'succeeded';
      open.latencyMs = num(data['latencyMs']);
      open.requestId = str(data['requestId']);
      open.source = source(data['source']);
      open.simulated = typeof data['simulated'] === 'boolean' ? data['simulated'] : null;
      open.promptTokens = num(data['promptTokens']);
      open.completionTokens = num(data['completionTokens']);
      open = null;
    } else if (event.type === 'provider.request_failed' && open !== null) {
      open.endedAt = event.at;
      open.outcome = 'failed';
      open.error = errorInfo(data);
      open = null;
    }
  }
  return calls;
}

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const source = (value: unknown): ResultSource | null => (value === 'real' || value === 'mock' ? value : null);

function errorInfo(data: Record<string, unknown>): ProviderErrorInfo {
  return {
    code: (str(data['code']) ?? 'PROVIDER_FAILED') as ProviderErrorCode,
    stage: (str(data['stage']) ?? 'request') as ProviderErrorInfo['stage'],
    provider: str(data['provider']),
    model: str(data['model']),
    retryable: data['retryable'] === true,
    message: str(data['message']) ?? '',
    cause: str(data['cause']),
  };
}

/**
 * The approvals of a step: those that name it, plus the one the step is waiting
 * on even when that request carries no step id.
 */
function stepApprovals(state: StepState, own: readonly ApprovalRequest[], all: readonly ApprovalRequest[]): ApprovalRequest[] {
  const list = [...own];
  if (state.waitingFor !== null && !list.some((a) => a.id === state.waitingFor)) {
    const waiting = all.find((a) => a.id === state.waitingFor);
    if (waiting !== undefined) list.push(waiting);
  }
  return list;
}

/** QA rounds live both on their own and inside the run state; the id decides. */
function mergeQaRounds(stored: readonly QAResult[], inState: readonly QAResult[]): QAResult[] {
  const byId = new Map<string, QAResult>();
  for (const round of [...stored, ...inState]) if (!byId.has(round.id)) byId.set(round.id, round);
  return [...byId.values()].sort((a, b) => a.round - b.round || stageOrder(a) - stageOrder(b));
}

function stageOrder(round: QAResult): number {
  return round.stage === 'workers' ? 0 : 1;
}

/** Every issue raised against a step, across every round. */
function groupQaIssues(rounds: readonly QAResult[]): Map<string, QAIssue[]> {
  return groupBy(
    rounds.flatMap((round) => round.issues),
    (issue) => issue.stepId,
  );
}

function groupBy<T>(items: readonly T[], key: (item: T) => string | null): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    if (k === null) continue;
    const bucket = groups.get(k);
    if (bucket === undefined) groups.set(k, [item]);
    else bucket.push(item);
  }
  return groups;
}
