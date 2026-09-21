import { useEffect, useRef, useState } from 'react';

import { AgentPipeline } from '../components/AgentPipeline.tsx';
import { Icon } from '../components/icons.tsx';
import {
  Button,
  ErrorBanner,
  ListSkeleton,
  Panel,
  ProgressBar,
  SectionTitle,
  Segmented,
  Skeleton,
  StatusChip,
} from '../components/primitives.tsx';
import { Markdown } from '../lib/markdown.tsx';
import { absoluteTime, cleanPrompt, cx, duration, extractDirectives, relativeTime } from '../lib/format.ts';
import { api, ApiClientError } from '../lib/api.ts';
import { href, useRouter } from '../lib/router.tsx';
import { useAgentCatalog, useMission } from '../hooks/useApi.ts';
import { useMissionMadre } from '../hooks/useMadre.ts';
import { ContentPanel } from '../components/ContentPanel.tsx';
import { SitePanel } from '../components/SitePanel.tsx';
import { RunPanel } from '../components/madre/RunPanel.tsx';
import { t } from '../i18n/index.ts';

export function MissionPage({ id }: { id: string }) {
  const { navigate } = useRouter();
  const mission = useMission(id);
  const catalog = useAgentCatalog();
  const madre = useMissionMadre(id, mission.data === null || mission.data.status === 'pending' || mission.data.status === 'running');
  const [view, setView] = useState<'result' | 'plan'>('result');
  const pendingCount = madre.data?.approvals.filter((a) => a.status === 'pending').length ?? 0;
  const showedPending = useRef(false);

  // When the crew needs something from the person, take them to it once.
  useEffect(() => {
    if (pendingCount > 0 && !showedPending.current) {
      showedPending.current = true;
      setView('plan');
    }
    if (pendingCount === 0) showedPending.current = false;
  }, [pendingCount]);

  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [rerunning, setRerunning] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  if (mission.loading && mission.data === null) {
    return (
      <div className="space-y-5" role="status" aria-label={t.missions.detail.loading}>
        <Skeleton className="h-4 w-24" />
        <Panel className="space-y-3 p-4">
          <Skeleton className="h-5 w-3/4" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-1 w-full" />
        </Panel>
        <ListSkeleton rows={4} />
      </div>
    );
  }

  if (mission.data === null) {
    return (
      <div className="space-y-4">
        <ErrorBanner message={mission.error ?? t.missions.detail.notFound} onRetry={mission.refresh} />
        <Button variant="ghost" onClick={() => navigate({ name: 'missions' })}>
          {t.missions.detail.backToList}
        </Button>
      </div>
    );
  }

  const detail = mission.data;
  const runs = detail.runs;
  const activeRun = runs.find((r) => r.id === selectedRunId) ?? runs[0];
  const isLatestRun = activeRun !== undefined && activeRun.id === runs[0]?.id;
  const busy = detail.status === 'running' || detail.status === 'pending';
  const directives = extractDirectives(detail.prompt);

  const failedCount = activeRun?.agents.filter((a) => a.status === 'failed').length ?? 0;
  const doneCount = activeRun?.agents.filter((a) => a.status === 'completed').length ?? 0;
  const tone = detail.status === 'failed' ? 'bad' : detail.status === 'completed' ? 'ok' : 'signal';
  const tokens = activeRun?.agents.reduce((sum, a) => sum + (a.usage?.totalTokens ?? 0), 0) ?? 0;

  async function rerun() {
    setRerunning(true);
    setActionError(null);
    try {
      await api.runMission(id);
      mission.refresh();
      setSelectedRunId(null);
    } catch (error) {
      setActionError(error instanceof ApiClientError ? error.message : t.missions.detail.runFailed);
    } finally {
      setRerunning(false);
    }
  }

  async function copyResult() {
    if (activeRun?.finalResult == null) return;
    try {
      await navigator.clipboard.writeText(activeRun.finalResult);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setActionError(t.missions.detail.copyFailed);
    }
  }

  return (
    <div className="space-y-5">
      <a
        href={href({ name: 'missions' })}
        className="inline-flex items-center gap-1 text-[0.78rem] text-[var(--color-ink-faint)] hover:text-[var(--color-ink-dim)]"
      >
        <Icon name="chevron-left" className="h-4 w-4" />
        {t.missions.detail.allMissions}
      </a>

      {/* ------------------------------------------------------- Mission header */}
      <Panel as="section" className="p-4 sm:p-5">
        <div className="flex items-start justify-between gap-3">
          <h1 className="min-w-0 flex-1 text-lg font-semibold leading-snug tracking-tight text-[var(--color-ink)] sm:text-xl">
            {cleanPrompt(detail.title)}
          </h1>
          <StatusChip status={detail.status} kind="mission" />
        </div>

        <div className="mt-3">
          <p className="mb-1 text-[0.66rem] font-semibold uppercase tracking-[0.16em] text-[var(--color-ink-faint)]">
            {t.missions.detail.objective}
          </p>
          <p className="whitespace-pre-wrap text-[0.88rem] leading-relaxed text-[var(--color-ink-dim)]">
            {cleanPrompt(detail.prompt)}
          </p>
        </div>

        {directives.length > 0 && (
          <p className="mt-2.5 flex flex-wrap items-center gap-1.5 text-[0.7rem] text-[var(--color-ink-faint)]">
            <span>{t.missions.detail.directives}</span>
            {directives.map((directive) => (
              <code
                key={directive}
                className="rounded bg-amber-500/12 px-1.5 py-0.5 font-mono text-amber-800 dark:text-amber-300"
              >
                {directive}
              </code>
            ))}
          </p>
        )}

        {activeRun && (
          <div className="mt-4">
            <ProgressBar value={activeRun.progress} tone={tone} />
            <div className="tabular mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[0.72rem] text-[var(--color-ink-faint)]">
              <span className="font-medium text-[var(--color-ink-dim)]">{t.missions.detail.percentComplete(Math.round(activeRun.progress * 100))}</span>
              <span>{t.missions.detail.agentsDone(doneCount, activeRun.agents.length)}</span>
              {failedCount > 0 && (
                <span className="text-[var(--color-bad)]">{t.missions.detail.failedAgents(failedCount)}</span>
              )}
              <span className="ml-auto" title={absoluteTime(detail.createdAt)}>
                {t.missions.detail.created(relativeTime(detail.createdAt))}
              </span>
            </div>
          </div>
        )}

        <div className="mt-4 flex flex-wrap gap-2">
          <Button onClick={rerun} busy={rerunning} disabled={busy} variant={busy ? 'ghost' : 'primary'} className="flex-1 sm:flex-none">
            {!rerunning && <Icon name={busy ? 'clock' : 'refresh'} className="h-4 w-4" />}
            {busy ? t.missions.detail.runInProgress : t.missions.detail.runAgain}
          </Button>
          {activeRun?.finalResult != null && (
            <Button variant="ghost" onClick={copyResult} className="flex-1 sm:flex-none">
              <Icon name={copied ? 'check' : 'copy'} className="h-4 w-4" />
              {copied ? t.missions.detail.copied : t.missions.detail.copyResult}
            </Button>
          )}
        </div>

        {actionError !== null && (
          <p
            role="alert"
            className="mt-2.5 rounded-lg border border-rose-500/30 bg-rose-500/8 px-3 py-2 text-[0.8rem] text-rose-800 dark:text-rose-200"
          >
            {actionError}
          </p>
        )}
      </Panel>

      {mission.error !== null && (
        <ErrorBanner message={t.missions.detail.liveInterrupted(mission.error)} onRetry={mission.refresh} />
      )}

      {/* --------------------------------------------------------- Run selector */}
      {runs.length > 1 && (
        <section>
          <SectionTitle>{t.missions.detail.runHistory}</SectionTitle>
          <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
            <div className="flex w-max gap-1.5 sm:w-auto sm:flex-wrap">
              {runs.map((run) => (
                <button
                  key={run.id}
                  type="button"
                  onClick={() => setSelectedRunId(run.id)}
                  aria-pressed={run.id === activeRun?.id}
                  className={cx(
                    'shrink-0 rounded-xl px-3.5 py-2 text-left transition',
                    run.id === activeRun?.id
                      ? 'bg-[var(--color-signal)]/12 ring-1 ring-[var(--color-signal)]/40'
                      : 'bg-[var(--color-tint)] ring-1 ring-[var(--color-line)] hover:bg-[var(--color-tint-strong)]',
                  )}
                >
                  <span className="tabular block text-[0.78rem] font-medium text-[var(--color-ink)]">{t.missions.detail.runNumber(run.attempt)}</span>
                  <span className="block text-[0.64rem] uppercase tracking-wider text-[var(--color-ink-faint)]">
                    {t.missions.detail.runStatus[run.status] ?? run.status}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </section>
      )}

      {madre.data?.runId != null && (
        <Segmented
          label={t.missions.detail.viewAria}
          value={view}
          onChange={setView}
          options={[
            { value: 'result', label: t.missions.detail.viewResult },
            {
              value: 'plan',
              label: t.missions.detail.viewPlan,
              count: pendingCount || undefined,
            },
          ]}
        />
      )}

      {view === 'plan' && madre.data?.runId != null && (
        <div className="acc-fade">
          <RunPanel missionId={id} madre={madre} onChanged={mission.refresh} />
        </div>
      )}

      <div className={cx('grid grid-cols-1 items-start gap-5 xl:grid-cols-2', view === 'plan' && madre.data?.runId != null && 'hidden')}>
        {/* ------------------------------------------------------------ Pipeline */}
        {activeRun && (
          <section>
            <SectionTitle
              action={
                <span className="tabular font-mono text-[0.68rem] text-[var(--color-ink-faint)]">
                  {activeRun.providerId}/{activeRun.model}
                </span>
              }
            >
              {t.missions.detail.runTitle(isLatestRun, activeRun.attempt, activeRun.agents.length)}
            </SectionTitle>
            <AgentPipeline run={activeRun} catalog={catalog} />

            {activeRun.error !== null && (
              <p
                role="alert"
                className="mt-3 rounded-lg border border-rose-500/30 bg-rose-500/8 px-3 py-2 text-[0.82rem] text-rose-800 dark:text-rose-200"
              >
                {activeRun.error}
              </p>
            )}

            <dl className="tabular mt-3 flex flex-wrap gap-x-4 gap-y-1 px-1 text-[0.7rem] text-[var(--color-ink-faint)]">
              <div className="flex gap-1">
                <dt>{t.missions.detail.startedAt}</dt>
                <dd className="text-[var(--color-ink-dim)]">{absoluteTime(activeRun.startedAt)}</dd>
              </div>
              {activeRun.startedAt !== null && activeRun.completedAt !== null && (
                <div className="flex gap-1">
                  <dt>{t.missions.detail.tookLabel}</dt>
                  <dd className="text-[var(--color-ink-dim)]">
                    {duration(new Date(activeRun.completedAt).getTime() - new Date(activeRun.startedAt).getTime())}
                  </dd>
                </div>
              )}
              <div className="flex gap-1">
                <dt>{t.missions.detail.tokens}</dt>
                <dd className="text-[var(--color-ink-dim)]">{tokens}</dd>
              </div>
            </dl>
          </section>
        )}

        {/* --------------------------------------------------------- Final result */}
        <div className="space-y-5">
          {activeRun?.finalResult != null && (
            <section>
              <SectionTitle>{isLatestRun ? t.missions.detail.finalResult : t.missions.detail.resultOfRun(activeRun.attempt)}</SectionTitle>
              <Panel className="border-[var(--color-signal)]/30 p-4 sm:p-5">
                {failedCount > 0 && (
                  <p className="mb-3 rounded-lg border border-amber-500/35 bg-amber-500/8 px-3 py-2 text-[0.8rem] text-amber-900 dark:border-amber-400/25 dark:text-amber-200">
                    {t.missions.detail.incompleteBrief(failedCount)}
                  </p>
                )}
                <Markdown source={activeRun.finalResult} />
              </Panel>
            </section>
          )}

          {activeRun?.finalResult != null && <ContentPanel missionId={detail.id} />}
          {activeRun?.finalResult != null && <SitePanel missionId={detail.id} finalResult={activeRun.finalResult} />}

          {activeRun?.finalResult == null && activeRun?.status === 'failed' && (
            <Panel className="border-rose-500/30 px-4 py-6 text-center">
              <p className="text-sm text-[var(--color-ink-dim)]">
                {t.missions.detail.noFinalResult}
              </p>
            </Panel>
          )}

          {activeRun?.finalResult == null && busy && (
            <Panel className="px-4 py-8 text-center">
              <p className="text-sm font-medium text-[var(--color-ink)]">{t.missions.detail.finalPendingTitle}</p>
              <p className="mx-auto mt-1 max-w-xs text-[0.8rem] text-[var(--color-ink-faint)]">
                {t.missions.detail.finalPendingBody}
              </p>
            </Panel>
          )}
        </div>
      </div>
    </div>
  );
}
