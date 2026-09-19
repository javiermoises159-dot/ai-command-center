import { cleanPrompt, cx, relativeTime } from '../lib/format.ts';
import { href } from '../lib/router.tsx';
import type { MissionSummary } from '../lib/api.ts';
import { ProgressBar, StatusChip } from './primitives.tsx';

export function MissionCard({ summary }: { summary: MissionSummary }) {
  const { agentCounts } = summary;
  const settled = agentCounts.completed + agentCounts.failed + agentCounts.skipped;
  const total = settled + agentCounts.pending + agentCounts.running;
  const progress = total === 0 ? 0 : settled / total;

  const tone = summary.status === 'failed' ? 'bad' : summary.status === 'completed' ? 'ok' : 'signal';

  return (
    <a
      href={href({ name: 'mission', id: summary.id })}
      className={cx(
        'panel block px-3.5 py-3 transition',
        'hover:border-[var(--color-edge-bright)] active:scale-[0.995]',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <h3 className="min-w-0 flex-1 text-sm font-medium leading-snug text-[var(--color-ink)]">
          {cleanPrompt(summary.title)}
        </h3>
        <StatusChip status={summary.status} kind="mission" />
      </div>

      <div className="mt-2.5">
        <ProgressBar value={progress} tone={tone} />
      </div>

      <div className="tabular mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.68rem] text-[var(--color-ink-faint)]">
        <span>
          {settled}/{total || 8} agents
        </span>
        {agentCounts.failed > 0 && <span className="text-rose-300">{agentCounts.failed} failed</span>}
        {summary.runCount > 1 && <span>{summary.runCount} runs</span>}
        <span className="ml-auto">{relativeTime(summary.createdAt)}</span>
      </div>
    </a>
  );
}
