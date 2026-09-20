import { useState } from 'react';

import type { MadreSnapshot, MadreStepState } from '@acc/contracts';

import { api, ApiClientError } from '../../lib/api.ts';
import { clockTime, cx, duration, relativeTime } from '../../lib/format.ts';
import { Markdown } from '../../lib/markdown.tsx';
import {
  STEP_LABELS,
  VERDICT_LABELS,
  activeSteps,
  confidenceLabel,
  confidenceTone,
  costLabel,
  orderedSteps,
  phaseLabel,
  phaseTone,
  planProgress,
  runIsLive,
  stepTone,
  verdictTone,
} from '../../lib/madre.ts';
import { useMissionMadre } from '../../hooks/useMadre.ts';
import { Icon } from '../icons.tsx';
import { Badge, Button, ErrorBanner, Panel, ProgressBar, SectionTitle, Skeleton } from '../primitives.tsx';
import { ApprovalCard } from './ApprovalCard.tsx';
import { t } from '../../i18n/index.ts';

/**
 * The MADRE view of one mission: what was planned, what each step is doing and
 * on which model, what QA said, and what is waiting for a person. Everything is
 * read from GET /api/missions/:id/madre.
 */
export function RunPanel({ missionId, madre, onChanged }: { missionId: string; madre: ReturnType<typeof useMissionMadre>; onChanged: () => void }) {
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);

  if (madre.loading && madre.data === null) return <Skeleton className="h-28 w-full" />;
  if (madre.data === null) return madre.error !== null ? <ErrorBanner message={madre.error} onRetry={madre.refresh} /> : null;

  const snap: MadreSnapshot = madre.data;
  if (snap.runId === null || snap.state === null || snap.plan === null) {
    return (
      <Panel className="px-4 py-3 text-[0.8rem] text-[var(--color-ink-faint)]">
        {t.missions.run.notMadre}
      </Panel>
    );
  }

  const { state, plan } = snap;
  const progress = planProgress(state);
  const pending = snap.approvals.filter((a) => a.status === 'pending');
  const live = runIsLive(state);
  const active = activeSteps(plan, state);
  const canCancel = live || state.phase === 'paused';
  const lastQa = state.qaRounds[state.qaRounds.length - 1] ?? null;

  async function cancel() {
    setCancelling(true);
    setCancelError(null);
    try {
      await api.cancelMission(missionId);
      madre.refresh();
      onChanged();
    } catch (caught) {
      setCancelError(caught instanceof ApiClientError ? caught.message : t.missions.run.cancelFailed);
    } finally {
      setCancelling(false);
    }
  }

  function decided() {
    madre.refresh();
    onChanged();
  }

  return (
    <div className="space-y-5">
      {/* ------------------------------------------------------------- Status */}
      <Panel as="section" className="p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Badge tone={phaseTone(state.phase)}>{phaseLabel(state.phase)}</Badge>
            {state.mode === 'classic' && <Badge tone="neutral">{t.missions.run.classicMode}</Badge>}
            {live && <span className="h-2 w-2 rounded-full bg-[var(--color-signal)] acc-pulse" aria-hidden />}
          </div>
          <span className="tabular text-[0.72rem] text-[var(--color-ink-faint)]">
            {t.missions.run.stepsDone(progress.done, progress.total)}
          </span>
        </div>
        {state.recovery !== undefined && (
          <div role="status" className="mt-3 rounded-lg bg-[var(--color-warn)]/10 px-3 py-2 text-[0.78rem] text-[var(--color-ink-dim)]">
            <p className="font-medium text-[var(--color-ink)]">{t.missions.run.recoveredTitle} · {relativeTime(state.recovery.at)}</p>
            <p className="mt-0.5">{state.recovery.reason}</p>
            <p className="mt-0.5 text-[var(--color-ink-faint)]">{state.recovery.retryable ? t.missions.run.recoveredRetryable : t.missions.run.recoveredFinal}</p>
          </div>
        )}
        <div className="mt-3">
          <ProgressBar value={progress.fraction} tone={state.phase === 'failed' ? 'bad' : state.phase === 'completed' ? 'ok' : 'signal'} />
        </div>

        <dl className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Fact label={t.missions.run.confidence} value={confidenceLabel(state.confidence)} tone={confidenceTone(state.confidence)} hint={t.missions.run.confidenceHint} />
          <Fact label={t.missions.run.qaVerdict} value={lastQa === null ? t.missions.run.qaPending : VERDICT_LABELS[lastQa.verdict]} tone={lastQa === null ? 'neutral' : verdictTone(lastQa.verdict)} />
          <Fact label={t.missions.run.cost} value={costLabel(state.cost)} />
          <Fact label={t.missions.run.calls} value={String(state.cost.calls)} />
        </dl>

        {active.length > 0 && (
          <ul className="mt-4 space-y-1.5" aria-label={t.missions.run.workingNow}>
            {active.map((step) => (
              <li key={step.stepId} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-lg bg-[var(--color-signal)]/8 px-3 py-2 text-[0.8rem]">
                <span className="h-2 w-2 rounded-full bg-[var(--color-signal)] acc-pulse" aria-hidden />
                <span className="font-medium text-[var(--color-ink)]">{step.title}</span>
                <span className="text-[var(--color-ink-faint)]">· {t.missions.labels.agentName(step.agentId)}</span>
                {step.provider !== null && <span className="ml-auto font-mono text-[0.7rem] text-[var(--color-ink-faint)]">{step.provider}/{step.model}</span>}
              </li>
            ))}
          </ul>
        )}

        {canCancel && (
          <div className="mt-4">
            <Button variant="danger" onClick={() => void cancel()} busy={cancelling} className="w-full sm:w-auto">
              <Icon name="x" className="h-4 w-4" />
              {t.missions.run.cancelRun}
            </Button>
          </div>
        )}
        {cancelError !== null && <p role="alert" className="mt-2 text-[0.78rem] text-[var(--color-bad)]">{cancelError}</p>}
      </Panel>

      {/* ---------------------------------------------------------- Approvals */}
      {pending.length > 0 && (
        <section aria-label={t.missions.run.waitingAria} className="space-y-3">
          <SectionTitle>{t.missions.run.waitingForYou(pending.length)}</SectionTitle>
          {pending.map((a) => (
            <ApprovalCard key={a.id} approval={a} onDecided={decided} />
          ))}
        </section>
      )}

      {/* ------------------------------------------- Blockers and next action */}
      {(state.blockers.length > 0 || (state.nextAction !== null && state.nextAction.kind !== 'none')) && (
        <section className="space-y-3">
          {state.blockers.length > 0 && (
            <>
              <SectionTitle>{t.missions.run.blockers}</SectionTitle>
              <Panel className="divide-y divide-[var(--color-edge)]">
                {state.blockers.map((b, index) => (
                  <div key={`${b.kind}-${b.stepId ?? index}`} className="px-4 py-3">
                    <p className="flex flex-wrap items-center gap-2 text-[0.84rem] font-medium text-[var(--color-ink)]">
                      <Badge tone="warn">{t.missions.labels.blockerKind(b.kind)}</Badge>
                      {b.reason}
                    </p>
                    <p className="mt-1 text-[0.78rem] text-[var(--color-ink-faint)]">
                      <span className="font-medium text-[var(--color-ink-dim)]">{t.missions.run.toResolve}</span>
                      {b.resolution}
                    </p>
                  </div>
                ))}
              </Panel>
            </>
          )}
          {state.nextAction !== null && state.nextAction.kind !== 'none' && (
            <Panel className="border-[var(--color-signal)]/30 p-4">
              <p className="text-[0.66rem] font-semibold uppercase tracking-[0.16em] text-[var(--color-signal)]">{t.missions.run.nextAction}</p>
              <p className="mt-1 text-[0.9rem] font-medium text-[var(--color-ink)]">{state.nextAction.title}</p>
              <p className="mt-1 text-[0.8rem] leading-relaxed text-[var(--color-ink-dim)]">{state.nextAction.detail}</p>
            </Panel>
          )}
        </section>
      )}

      {/* --------------------------------------------------------------- Plan */}
      <section>
        <SectionTitle
          action={
            <span className="text-[0.68rem] text-[var(--color-ink-faint)]">
              {t.missions.run.planMeta(
                t.missions.labels.intentKind(plan.compiled.intent.kind),
                t.missions.labels.complexity(plan.compiled.intent.complexity),
              )}
            </span>
          }
        >
          {t.missions.run.planTitle}
        </SectionTitle>
        <ol className="space-y-2">
          {orderedSteps(plan, state).map(({ step, state: stepState }) => (
            <StepRow key={step.id} title={step.title} agentId={step.agentId} kind={step.kind} state={stepState} />
          ))}
        </ol>
        {plan.gaps.length > 0 && (
          <div className="mt-3 rounded-xl border border-amber-500/30 bg-amber-500/8 px-3.5 py-3 text-[0.78rem] text-amber-900 dark:text-amber-200">
            <p className="font-semibold">{t.missions.run.gapsTitle}</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-4">
              {plan.gaps.map((gap) => (
                <li key={gap.capability}>{gap.reason}</li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {/* ----------------------------------------------------------------- QA */}
      {state.qaRounds.length > 0 && (
        <section>
          <SectionTitle>{t.missions.run.qaTitle}</SectionTitle>
          <div className="space-y-2">
            {state.qaRounds.map((round) => (
              <Panel key={round.id} className="p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={verdictTone(round.verdict)}>{VERDICT_LABELS[round.verdict]}</Badge>
                  <span className="text-[0.76rem] text-[var(--color-ink-faint)]">
                    {t.missions.run.qaRound(t.missions.labels.qaStage(round.stage), round.round)}
                  </span>
                </div>
                <p className="mt-2 text-[0.8rem] leading-relaxed text-[var(--color-ink-dim)]">{round.summary}</p>
                {round.issues.length > 0 && (
                  <ul className="mt-2 space-y-1.5">
                    {round.issues.map((issue) => (
                      <li key={issue.id} className="text-[0.78rem] text-[var(--color-ink-dim)]">
                        <Badge tone={issue.severity === 'info' ? 'neutral' : issue.severity === 'warning' ? 'warn' : 'bad'} className="mr-1.5">
                          {t.missions.labels.severity(issue.severity)}
                        </Badge>
                        {issue.message}
                        {issue.suggestion !== null && <span className="block pl-1 text-[var(--color-ink-faint)]">→ {issue.suggestion}</span>}
                      </li>
                    ))}
                  </ul>
                )}
                <p className="mt-2 text-[0.66rem] text-[var(--color-ink-faint)]">{round.judge.note}</p>
              </Panel>
            ))}
          </div>
        </section>
      )}

      {/* -------------------------------------------------------------- Audit */}
      {snap.audit.length > 0 && (
        <details className="panel px-4 py-3">
          <summary className="cursor-pointer text-[0.78rem] font-medium text-[var(--color-ink-dim)]">{t.missions.run.auditTitle(snap.audit.length)}</summary>
          <ol className="mt-3 space-y-1.5">
            {snap.audit.map((event) => (
              <li key={event.id} className="flex gap-2 text-[0.74rem]">
                <time dateTime={event.at} className="tabular shrink-0 text-[var(--color-ink-faint)]">{clockTime(event.at)}</time>
                <span className="w-16 shrink-0 uppercase tracking-wider text-[var(--color-ink-faint)]">{t.missions.labels.auditActor(event.actor)}</span>
                <span className="min-w-0 text-[var(--color-ink-dim)]">{event.message}</span>
              </li>
            ))}
          </ol>
        </details>
      )}
    </div>
  );
}

function Fact({ label, value, tone = 'neutral', hint }: { label: string; value: string; tone?: 'neutral' | 'ok' | 'warn' | 'bad' | 'signal'; hint?: string }) {
  return (
    <div className="rounded-lg bg-[var(--color-tint)] px-3 py-2" title={hint}>
      <dd
        className={cx(
          'tabular text-[0.9rem] font-semibold',
          tone === 'ok' && 'text-[var(--color-ok)]',
          tone === 'warn' && 'text-[var(--color-warn)]',
          tone === 'bad' && 'text-[var(--color-bad)]',
          tone === 'signal' && 'text-[var(--color-signal)]',
          tone === 'neutral' && 'text-[var(--color-ink)]',
        )}
      >
        {value}
      </dd>
      <dt className="mt-0.5 text-[0.6rem] uppercase tracking-wider text-[var(--color-ink-faint)]">{label}</dt>
    </div>
  );
}

function StepRow({ title, agentId, kind, state }: { title: string; agentId: string; kind: string; state: MadreStepState | null }) {
  const status = state?.status ?? 'QUEUED';
  const routing = state?.routing ?? null;
  const result = state?.result ?? null;
  const took = state?.startedAt != null && state.completedAt != null ? new Date(state.completedAt).getTime() - new Date(state.startedAt).getTime() : null;

  return (
    <li>
      <Panel as="article" className={cx('px-4 py-3', status === 'RUNNING' && 'border-cyan-500/40', status === 'WAITING' && 'border-amber-500/40')}>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <h3 className="min-w-0 flex-1 text-[0.86rem] font-medium text-[var(--color-ink)]">{title}</h3>
          <Badge tone={stepTone(status)}>{STEP_LABELS[status]}</Badge>
        </div>
        <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[0.72rem] text-[var(--color-ink-faint)]">
          <span>{t.missions.labels.agentName(agentId)}</span>
          {kind !== 'agent' && <span>· {t.missions.labels.stepKind(kind)}</span>}
          {routing?.provider != null && (
            <span className="font-mono">
              · {routing.provider.id}/{routing.provider.model}
            </span>
          )}
          {(result?.simulated === true || (result === null && routing !== null && routing.execution === 'simulated')) && <Badge tone="warn">{t.missions.run.step.simulated}</Badge>}
          {result?.source === 'real' && result.simulated === false && <Badge tone="ok">{t.missions.run.step.real}</Badge>}
          {state !== null && state.attempts > 1 && <span>· {t.missions.run.step.attempts(state.attempts)}</span>}
          {state !== null && state.revisions > 0 && <span>· {t.missions.run.step.revised(state.revisions)}</span>}
          {took !== null && <span>· {duration(took)}</span>}
        </p>

        {state?.blockedReason != null && <p className="mt-1.5 text-[0.76rem] text-[var(--color-warn)]">{state.blockedReason}</p>}
        {state?.error != null && <p className="mt-1.5 text-[0.76rem] text-[var(--color-bad)]">{state.error}</p>}
        {state?.providerError != null && (
          <p className="mt-1 font-mono text-[0.68rem] text-[var(--color-ink-faint)]">{t.missions.run.step.providerError(state.providerError.code, state.providerError.stage)}</p>
        )}
        {routing !== null && routing.warnings.length > 0 && (
          <ul className="mt-1.5 list-disc pl-4 text-[0.72rem] text-[var(--color-ink-faint)]">
            {routing.warnings.slice(0, 3).map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        )}

        {result !== null && result.text !== '' && (
          <details className="mt-2">
            <summary className="cursor-pointer text-[0.74rem] font-medium text-[var(--color-signal)]">
              {t.missions.run.step.resultSummary(
                result.costUsd === null ? null : result.costUsd === 0 ? t.missions.run.step.free : `$${result.costUsd.toFixed(4)}`,
                result.caveats.length,
              )}
            </summary>
            {result.caveats.length > 0 && (
              <ul className="mt-2 list-disc pl-4 text-[0.74rem] text-[var(--color-warn)]">
                {result.caveats.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            )}
            {result.requestId != null && <p className="mt-2 break-all font-mono text-[0.66rem] text-[var(--color-ink-faint)]">{t.missions.run.step.requestId(result.requestId)}</p>}
            <div className="mt-2 rounded-lg bg-[var(--color-tint)] p-3">
              <Markdown source={result.text} />
            </div>
          </details>
        )}
        {state?.completedAt != null && <p className="mt-1.5 text-[0.64rem] text-[var(--color-ink-faint)]">{t.missions.run.step.finished(relativeTime(state.completedAt))}</p>}
      </Panel>
    </li>
  );
}
