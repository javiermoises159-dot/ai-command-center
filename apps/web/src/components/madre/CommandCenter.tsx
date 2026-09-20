import type { MissionSummary } from '../../lib/api.ts';
import { cleanPrompt, cx } from '../../lib/format.ts';
import {
  VERDICT_LABELS,
  activeSteps,
  confidenceLabel,
  confidenceTone,
  costLabel,
  phaseLabel,
  phaseTone,
  planProgress,
  runIsLive,
  verdictTone,
} from '../../lib/madre.ts';
import { href } from '../../lib/router.tsx';
import { useMadreOverview, useMissionMadre } from '../../hooks/useMadre.ts';
import { Icon } from '../icons.tsx';
import { Badge, Panel, ProgressBar, SectionTitle, Skeleton } from '../primitives.tsx';
import { ApprovalCard } from './ApprovalCard.tsx';
import { t } from '../../i18n/index.ts';

/**
 * The Dashboard's answer to "what is the system doing right now?": the current
 * mission's progress, who is working on it and with which model, what it has
 * cost, how sure MADRE is, what is blocking it and what to do next — plus what
 * MADRE can and cannot do today. All of it is read from the API.
 */
export function CommandCenter({ missions }: { missions: readonly MissionSummary[] }) {
  const current = missions.find((m) => m.status === 'running' || m.status === 'pending') ?? missions[0] ?? null;
  const active = current !== null && (current.status === 'running' || current.status === 'pending');
  const madre = useMissionMadre(current?.id ?? null, active);
  const overview = useMadreOverview(active);

  const snap = madre.data;
  const state = snap?.state ?? null;
  const plan = snap?.plan ?? null;
  const working = activeSteps(plan, state);
  const pending = snap?.approvals.filter((a) => a.status === 'pending') ?? [];
  const lastQa = state?.qaRounds[state.qaRounds.length - 1] ?? null;

  const providers = state === null ? [] : [...new Set(state.steps.flatMap((s) => (s.routing?.provider != null ? [`${s.routing.provider.id}`] : [])))];
  const tools = state === null ? [] : [...new Set(state.steps.flatMap((s) => s.routing?.tools.filter((t) => t.usable).map((t) => t.toolId) ?? []))];
  const world = overview.data?.world ?? null;

  return (
    <section aria-label={t.dashboard.commandCenter.title} className="space-y-3">
      <SectionTitle
        action={
          world !== null ? (
            <span className="tabular text-[0.7rem] text-[var(--color-ink-faint)]">
              {t.dashboard.commandCenter.worldSummary(world.agents.active, world.tools.AVAILABLE + world.tools.CONNECTED)}
            </span>
          ) : undefined
        }
      >
        {t.dashboard.commandCenter.title}
      </SectionTitle>

      <Panel className="p-4 sm:p-5">
        {current === null ? (
          <p className="text-[0.86rem] text-[var(--color-ink-dim)]">
            {t.dashboard.commandCenter.empty}
          </p>
        ) : madre.loading && snap === null ? (
          <div className="space-y-3" role="status" aria-label={t.dashboard.commandCenter.loadingState}>
            <Skeleton className="h-5 w-2/3" />
            <Skeleton className="h-1 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-[0.66rem] font-semibold uppercase tracking-[0.16em] text-[var(--color-ink-faint)]">
                  {active ? t.dashboard.commandCenter.currentMission : t.dashboard.commandCenter.latestMission}
                </p>
                <a href={href({ name: 'mission', id: current.id })} className="mt-0.5 block truncate text-[1rem] font-semibold text-[var(--color-ink)] hover:text-[var(--color-signal)]">
                  {cleanPrompt(current.title)}
                </a>
              </div>
              {state !== null ? <Badge tone={phaseTone(state.phase)}>{phaseLabel(state.phase)}</Badge> : <Badge>{t.dashboard.commandCenter.classic}</Badge>}
            </div>

            {state === null || plan === null ? (
              <p className="text-[0.8rem] text-[var(--color-ink-faint)]">
                {t.dashboard.commandCenter.classicNote}
              </p>
            ) : (
              <>
                <div>
                  <ProgressBar value={planProgress(state).fraction} tone={state.phase === 'failed' ? 'bad' : state.phase === 'completed' ? 'ok' : 'signal'} />
                  <p className="tabular mt-1.5 text-[0.72rem] text-[var(--color-ink-faint)]">
                    {t.dashboard.commandCenter.stepsDone(planProgress(state).done, planProgress(state).total)}
                  </p>
                </div>

                {working.length > 0 && (
                  <ul className="space-y-1.5" aria-label={t.dashboard.commandCenter.workingNow}>
                    {working.map((step) => (
                      <li key={step.stepId} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-lg bg-[var(--color-signal)]/8 px-3 py-2 text-[0.8rem]">
                        <span className="h-2 w-2 rounded-full bg-[var(--color-signal)] acc-pulse" aria-hidden />
                        <span className="font-medium text-[var(--color-ink)]">{step.title}</span>
                        <span className="text-[var(--color-ink-faint)]">· {t.missions.labels.agentName(step.agentId)}</span>
                        {step.provider !== null && <span className="ml-auto font-mono text-[0.7rem] text-[var(--color-ink-faint)]">{step.provider}/{step.model}</span>}
                      </li>
                    ))}
                  </ul>
                )}

                <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <Cell label={t.dashboard.commandCenter.confidence} value={confidenceLabel(state.confidence)} tone={confidenceTone(state.confidence)} />
                  <Cell label={t.dashboard.commandCenter.qa} value={lastQa === null ? t.dashboard.commandCenter.qaPending : VERDICT_LABELS[lastQa.verdict]} tone={lastQa === null ? 'neutral' : verdictTone(lastQa.verdict)} />
                  <Cell label={t.dashboard.commandCenter.cost} value={costLabel(state.cost)} />
                  <Cell label={t.dashboard.commandCenter.models} value={providers.length === 0 ? '—' : providers.join(', ')} />
                </dl>

                {tools.length > 0 && (
                  <p className="text-[0.74rem] text-[var(--color-ink-faint)]">
                    <span className="font-medium text-[var(--color-ink-dim)]">{t.dashboard.commandCenter.toolsInUse}</span>
                    {tools.join(', ')}
                  </p>
                )}

                {state.blockers.length > 0 && (
                  <ul className="space-y-1.5" aria-label={t.dashboard.commandCenter.blockers}>
                    {state.blockers.slice(0, 3).map((b, index) => (
                      <li key={`${b.kind}-${index}`} className="flex items-start gap-2 text-[0.78rem] text-[var(--color-ink-dim)]">
                        <Icon name="alert" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--color-warn)]" />
                        <span>
                          {b.reason}
                          <span className="block text-[var(--color-ink-faint)]">{b.resolution}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}

                {state.nextAction !== null && state.nextAction.kind !== 'none' && (
                  <div className="rounded-xl border border-[var(--color-signal)]/30 px-3.5 py-3">
                    <p className="text-[0.64rem] font-semibold uppercase tracking-[0.16em] text-[var(--color-signal)]">{t.dashboard.commandCenter.nextAction}</p>
                    <p className="mt-0.5 text-[0.86rem] font-medium text-[var(--color-ink)]">{state.nextAction.title}</p>
                    <p className="mt-0.5 text-[0.78rem] leading-relaxed text-[var(--color-ink-dim)]">{state.nextAction.detail}</p>
                  </div>
                )}

                {runIsLive(state) && (
                  <p className="flex items-center gap-2 text-[0.72rem] font-medium text-[var(--color-signal)]">
                    <span className="h-2 w-2 rounded-full bg-[var(--color-signal)] acc-pulse" aria-hidden />
                    {t.dashboard.commandCenter.live}
                  </p>
                )}
              </>
            )}
          </div>
        )}
      </Panel>

      {pending.map((approval) => (
        <ApprovalCard
          key={approval.id}
          approval={approval}
          onDecided={() => {
            madre.refresh();
            overview.refresh();
          }}
        />
      ))}

      {world !== null && (
        <details className="panel px-4 py-3">
          <summary className="cursor-pointer text-[0.78rem] font-medium text-[var(--color-ink-dim)]">{t.dashboard.commandCenter.limitsSummary}</summary>
          <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <p className="mb-1.5 text-[0.66rem] font-semibold uppercase tracking-[0.16em] text-[var(--color-ok)]">{t.dashboard.commandCenter.canDo}</p>
              <ul className="list-disc space-y-1 pl-4 text-[0.76rem] leading-relaxed text-[var(--color-ink-dim)]">
                {world.canDo.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
            <div>
              <p className="mb-1.5 text-[0.66rem] font-semibold uppercase tracking-[0.16em] text-[var(--color-warn)]">{t.dashboard.commandCenter.cannotDo}</p>
              <ul className="list-disc space-y-1 pl-4 text-[0.76rem] leading-relaxed text-[var(--color-ink-dim)]">
                {world.gaps.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
          </div>
        </details>
      )}
    </section>
  );
}

function Cell({ label, value, tone = 'neutral' }: { label: string; value: string; tone?: 'neutral' | 'ok' | 'warn' | 'bad' | 'signal' }) {
  return (
    <div className="min-w-0 rounded-lg bg-[var(--color-tint)] px-3 py-2">
      <dd
        className={cx(
          'tabular truncate text-[0.86rem] font-semibold',
          tone === 'ok' && 'text-[var(--color-ok)]',
          tone === 'warn' && 'text-[var(--color-warn)]',
          tone === 'bad' && 'text-[var(--color-bad)]',
          tone === 'signal' && 'text-[var(--color-signal)]',
          tone === 'neutral' && 'text-[var(--color-ink)]',
        )}
        title={value}
      >
        {value}
      </dd>
      <dt className="mt-0.5 text-[0.6rem] uppercase tracking-wider text-[var(--color-ink-faint)]">{label}</dt>
    </div>
  );
}
