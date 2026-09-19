import { useState } from 'react';

import { MissionCard } from '../components/MissionCard.tsx';
import { EmptyState, ErrorBanner, Spinner } from '../components/primitives.tsx';
import { cx } from '../lib/format.ts';
import type { MissionStatus } from '../lib/api.ts';
import { useMissions } from '../hooks/useApi.ts';

const FILTERS: { label: string; value: MissionStatus | 'all' }[] = [
  { label: 'All', value: 'all' },
  { label: 'Running', value: 'running' },
  { label: 'Completed', value: 'completed' },
  { label: 'Failed', value: 'failed' },
];

export function MissionsPage() {
  const [filter, setFilter] = useState<MissionStatus | 'all'>('all');
  const missions = useMissions(filter === 'all' ? {} : { status: filter });
  const items = missions.data?.items ?? [];

  return (
    <div className="space-y-4">
      <div className="-mx-4 overflow-x-auto px-4">
        <div className="flex gap-1.5">
          {FILTERS.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => setFilter(option.value)}
              className={cx(
                'shrink-0 rounded-full px-3.5 py-2 text-[0.75rem] transition',
                filter === option.value
                  ? 'bg-[var(--color-signal)]/15 text-[var(--color-signal)] ring-1 ring-[var(--color-signal)]/35'
                  : 'bg-white/5 text-[var(--color-ink-dim)] ring-1 ring-white/10 hover:bg-white/10',
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {missions.error !== null && items.length === 0 ? (
        <ErrorBanner message={missions.error} onRetry={missions.refresh} />
      ) : missions.loading && items.length === 0 ? (
        <div className="flex items-center justify-center gap-2 py-12 text-sm text-[var(--color-ink-faint)]">
          <Spinner /> Loading missions…
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          title={filter === 'all' ? 'No missions yet' : `No ${filter} missions`}
          body={
            filter === 'all'
              ? 'Launch one from the command screen.'
              : 'Try a different filter to see the rest of the history.'
          }
        />
      ) : (
        <>
          <p className="tabular text-[0.7rem] uppercase tracking-[0.14em] text-[var(--color-ink-faint)]">
            {missions.data?.total ?? items.length} mission{(missions.data?.total ?? 0) === 1 ? '' : 's'}
          </p>
          <div className="space-y-2">
            {items.map((summary) => (
              <MissionCard key={summary.id} summary={summary} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
