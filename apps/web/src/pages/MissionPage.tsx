import { useState } from 'react';

import { AgentPipeline } from '../components/AgentPipeline.tsx';
import {
  Button,
  ErrorBanner,
  Panel,
  ProgressBar,
  SectionTitle,
  Spinner,
  StatusChip,
} from '../components/primitives.tsx';
import { Markdown } from '../lib/markdown.tsx';
import { absoluteTime, cleanPrompt, cx, duration, extractDirectives, relativeTime } from '../lib/format.ts';
import { api, ApiClientError } from '../lib/api.ts';
import { href, useRouter } from '../lib/router.tsx';
import { useAgentCatalog, useMission } from '../hooks/useApi.ts';

export function MissionPage({ id }: { id: string }) {
  const { navigate } = useRouter();
  const mission = useMission(id);
  const catalog = useAgentCatalog();

  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [rerunning, setRerunning] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  if (mission.loading && mission.data === null) {
    return (
      <div className="flex items-center justify-center gap-2 py-16 text-sm text-[var(--color-ink-faint)]">
        <Spinner /> Loading mission…
      </div>
    );
  }

  if (mission.data === null) {
    return (
      <div className="space-y-4">
        <ErrorBanner message={mission.error ?? 'Mission not found.'} onRetry={mission.refresh} />
        <Button variant="ghost" onClick={() => navigate({ name: 'missions' })}>
          Back to missions
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
  const tone = detail.status === 'failed' ? 'bad' : detail.status === 'completed' ? 'ok' : 'signal';

  async function rerun() {
    setRerunning(true);
    setActionError(null);
    try {
      await api.runMission(id);
      mission.refresh();
      setSelectedRunId(null);
    } catch (error) {
      setActionError(error instanceof ApiClientError ? error.message : 'Could not start a new run.');
    } finally {
      setRerunning(false);
    }
  }

  return (
    <div className="space-y-5">
      <a
        href={href({ name: 'missions' })}
        className="inline-flex items-center gap-1.5 text-[0.75rem] text-[var(--color-ink-faint)] hover:text-[var(--color-ink-dim)]"
      >
        ‹ All missions
      </a>

      {/* ------------------------------------------------------- Mission header */}
      <Panel as="section" className="p-4">
        <div className="flex items-start justify-between gap-3">
          <h1 className="min-w-0 flex-1 text-base font-semibold leading-snug text-[var(--color-ink)]">
            {cleanPrompt(detail.title)}
          </h1>
          <StatusChip status={detail.status} kind="mission" />
        </div>

        <p className="mt-2.5 whitespace-pre-wrap text-[0.85rem] leading-relaxed text-[var(--color-ink-dim)]">
          {cleanPrompt(detail.prompt)}
        </p>

        {directives.length > 0 && (
          <p className="mt-2.5 flex flex-wrap items-center gap-1.5 text-[0.68rem] text-[var(--color-ink-faint)]">
            <span>Test directives active:</span>
            {directives.map((directive) => (
              <code key={directive} className="rounded bg-amber-400/10 px-1.5 py-0.5 font-mono text-amber-300">
                {directive}
              </code>
            ))}
          </p>
        )}

        {activeRun && (
          <div className="mt-3.5">
            <ProgressBar value={activeRun.progress} tone={tone} />
            <div className="tabular mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.68rem] text-[var(--color-ink-faint)]">
              <span>{Math.round(activeRun.progress * 100)}% complete</span>
              {failedCount > 0 && <span className="text-rose-300">{failedCount} failed</span>}
              <span className="ml-auto">{relativeTime(detail.createdAt)}</span>
            </div>
          </div>
        )}

        <div className="mt-4 flex gap-2">
          <Button onClick={rerun} busy={rerunning} disabled={busy} variant={busy ? 'ghost' : 'primary'} className="flex-1">
            {busy ? 'Run in progress…' : 'Run again'}
          </Button>
        </div>

        {actionError !== null && (
          <p className="mt-2.5 rounded-lg border border-rose-400/25 bg-rose-500/8 px-3 py-2 text-[0.8rem] text-rose-200">
            {actionError}
          </p>
        )}
      </Panel>

      {mission.error !== null && (
        <ErrorBanner message={`Live updates interrupted: ${mission.error}`} onRetry={mission.refresh} />
      )}

      {/* --------------------------------------------------------- Run selector */}
      {runs.length > 1 && (
        <section>
          <SectionTitle>Run history</SectionTitle>
          <div className="-mx-4 overflow-x-auto px-4">
            <div className="flex gap-1.5">
              {runs.map((run) => (
                <button
                  key={run.id}
                  type="button"
                  onClick={() => setSelectedRunId(run.id)}
                  className={cx(
                    'shrink-0 rounded-xl px-3 py-2 text-left transition',
                    run.id === activeRun?.id
                      ? 'bg-[var(--color-signal)]/12 ring-1 ring-[var(--color-signal)]/35'
                      : 'bg-white/5 ring-1 ring-white/10 hover:bg-white/10',
                  )}
                >
                  <span className="tabular block text-[0.75rem] font-medium text-[var(--color-ink)]">
                    Run #{run.attempt}
                  </span>
                  <span className="block text-[0.62rem] uppercase tracking-wider text-[var(--color-ink-faint)]">
                    {run.status}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* -------------------------------------------------------------- Pipeline */}
      {activeRun && (
        <section>
          <SectionTitle
            action={
              <span className="tabular font-mono text-[0.65rem] text-[var(--color-ink-faint)]">
                {activeRun.providerId}/{activeRun.model}
              </span>
            }
          >
            Pipeline {runs.length > 1 && `· run #${activeRun.attempt}`}
          </SectionTitle>
          <AgentPipeline run={activeRun} catalog={catalog} />

          {activeRun.error !== null && (
            <p className="mt-3 rounded-lg border border-rose-400/25 bg-rose-500/8 px-3 py-2 text-[0.8rem] text-rose-200">
              {activeRun.error}
            </p>
          )}

          <dl className="tabular mt-3 flex flex-wrap gap-x-4 gap-y-1 px-1 text-[0.65rem] text-[var(--color-ink-faint)]">
            <div className="flex gap-1">
              <dt>started</dt>
              <dd className="text-[var(--color-ink-dim)]">{absoluteTime(activeRun.startedAt)}</dd>
            </div>
            {activeRun.startedAt !== null && activeRun.completedAt !== null && (
              <div className="flex gap-1">
                <dt>took</dt>
                <dd className="text-[var(--color-ink-dim)]">
                  {duration(new Date(activeRun.completedAt).getTime() - new Date(activeRun.startedAt).getTime())}
                </dd>
              </div>
            )}
            <div className="flex gap-1">
              <dt>tokens</dt>
              <dd className="text-[var(--color-ink-dim)]">
                {activeRun.agents.reduce((sum, a) => sum + (a.usage?.totalTokens ?? 0), 0)}
              </dd>
            </div>
          </dl>
        </section>
      )}

      {/* --------------------------------------------------------- Final result */}
      {activeRun?.finalResult != null && (
        <section>
          <SectionTitle>{isLatestRun ? 'Final result' : `Result of run #${activeRun.attempt}`}</SectionTitle>
          <Panel className="border-[var(--color-signal)]/25 p-4">
            {failedCount > 0 && (
              <p className="mb-3 rounded-lg border border-amber-400/25 bg-amber-400/8 px-3 py-2 text-[0.78rem] text-amber-200">
                This brief is incomplete: {failedCount} agent{failedCount === 1 ? '' : 's'} failed, so the Integrator
                worked without their input.
              </p>
            )}
            <Markdown source={activeRun.finalResult} />
          </Panel>
        </section>
      )}

      {activeRun?.finalResult == null && activeRun?.status === 'failed' && (
        <Panel className="border-rose-400/25 px-4 py-5 text-center">
          <p className="text-sm text-[var(--color-ink-dim)]">
            No final result: the run stopped before the Integrator could produce one.
          </p>
        </Panel>
      )}
    </div>
  );
}
