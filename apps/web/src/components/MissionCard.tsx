import { absoluteTime, cleanPrompt, cx, excerpt, relativeTime } from '../lib/format.ts';
import { href } from '../lib/router.tsx';
import type { MissionSummary } from '../lib/api.ts';
import { Icon } from './icons.tsx';
import { ProgressBar, StatusChip } from './primitives.tsx';

export function MissionCard({ summary }: { summary: MissionSummary }) {
  const { agentCounts } = summary;
  const settled = agentCounts.completed + agentCounts.failed + agentCounts.skipped;
  const total = settled + agentCounts.pending + agentCounts.running;
  const progress = total === 0 ? 0 : settled / total;
  const tone = summary.status === 'failed' ? 'bad' : summary.status === 'completed' ? 'ok' : 'signal';

  const preview = excerpt(summary.finalResult);
  const failure = summary.status === 'failed' ? (summary.latestRun?.error ?? null) : null;

  return (
    <a
      href={href({ name: 'mission', id: summary.id })}
      className={cx(
        'panel group block px-4 py-3.5 transition',
        'hover:border-[var(--color-edge-bright)] hover:bg-[var(--color-surface-2)]/60 active:scale-[0.995]',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <h3 className="min-w-0 flex-1 text-[0.92rem] font-medium leading-snug text-[var(--color-ink)]">
          {cleanPrompt(summary.title)}
        </h3>
        <StatusChip status={summary.status} kind="mission" />
      </div>

      {/* One line of context: the result when there is one, otherwise why not. */}
      {preview !== '' ? (
        <p className="mt-2 flex items-start gap-2 text-[0.78rem] leading-relaxed text-[var(--color-ink-dim)]">
          <Icon name="file-text" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--color-ok)]" />
          <span className="line-clamp-2">{preview}</span>
        </p>
      ) : failure !== null ? (
        <p className="mt-2 flex items-start gap-2 text-[0.78rem] leading-relaxed text-[var(--color-bad)]">
          <Icon name="alert" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="line-clamp-2">{failure}</span>
        </p>
      ) : summary.status === 'running' || summary.status === 'pending' ? (
        <p className="mt-2 text-[0.78rem] text-[var(--color-ink-faint)]">
          The crew is working — {settled} of {total || 8} agents done.
        </p>
      ) : null}

      <div className="mt-3">
        <ProgressBar value={progress} tone={tone} />
      </div>

      <div className="tabular mt-2.5 flex flex-wrap items-center gap-x-3.5 gap-y-1 text-[0.7rem] text-[var(--color-ink-faint)]">
        <span>
          {settled}/{total || 8} agents
        </span>
        <span>
          {summary.runCount} run{summary.runCount === 1 ? '' : 's'}
        </span>
        {agentCounts.failed > 0 && <span className="text-[var(--color-bad)]">{agentCounts.failed} failed</span>}
        <span className="ml-auto" title={absoluteTime(summary.createdAt)}>
          {relativeTime(summary.createdAt)}
        </span>
      </div>
    </a>
  );
}
