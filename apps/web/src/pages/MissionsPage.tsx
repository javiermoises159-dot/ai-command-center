import { useState } from 'react';

import { Icon } from '../components/icons.tsx';
import { MissionCard } from '../components/MissionCard.tsx';
import { EmptyState, ErrorBanner, LinkButton, ListSkeleton, PageHeader, Segmented } from '../components/primitives.tsx';
import { cleanPrompt } from '../lib/format.ts';
import { href } from '../lib/router.tsx';
import type { MissionStatus } from '../lib/api.ts';
import { useMissions, useStats } from '../hooks/useApi.ts';

type Filter = MissionStatus | 'all';

export function MissionsPage() {
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');

  const missions = useMissions(filter === 'all' ? {} : { status: filter });
  const stats = useStats(false);

  const items = missions.data?.items ?? [];
  const needle = query.trim().toLowerCase();
  // Search runs over what is already loaded: titles and the original prompt.
  const visible =
    needle === ''
      ? items
      : items.filter((m) => `${cleanPrompt(m.title)} ${cleanPrompt(m.prompt)}`.toLowerCase().includes(needle));

  const options: { value: Filter; label: string; count?: number }[] = [
    { value: 'all', label: 'All', ...(stats.data ? { count: stats.data.total } : {}) },
    { value: 'running', label: 'Running', ...(stats.data ? { count: stats.data.running } : {}) },
    { value: 'completed', label: 'Completed', ...(stats.data ? { count: stats.data.completed } : {}) },
    { value: 'failed', label: 'Failed', ...(stats.data ? { count: stats.data.failed } : {}) },
  ];

  return (
    <div className="space-y-5">
      <PageHeader
        icon="target"
        title="Missions"
        description="Every mission you have launched, with its state, runs and result. Open one to watch the agents work."
        actions={
          <LinkButton href={href({ name: 'dashboard' })} variant="primary">
            <Icon name="plus" className="h-4 w-4" />
            New mission
          </LinkButton>
        }
      />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Segmented label="Filter missions by status" value={filter} onChange={setFilter} options={options} />

        <div className="relative sm:w-64">
          <Icon
            name="search"
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-ink-faint)]"
          />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search missions"
            aria-label="Search missions"
            className="min-h-[44px] w-full rounded-xl border border-[var(--color-edge-bright)] bg-[var(--color-field)] py-2 pl-9 pr-3 text-[var(--color-ink)] placeholder:text-[var(--color-ink-faint)] focus:border-[var(--color-signal)]/55 focus:outline-none focus:ring-2 focus:ring-[var(--color-signal)]/30"
          />
        </div>
      </div>

      {missions.error !== null && items.length === 0 ? (
        <ErrorBanner message={missions.error} onRetry={missions.refresh} />
      ) : missions.loading && items.length === 0 ? (
        <ListSkeleton rows={4} />
      ) : items.length === 0 ? (
        <EmptyState
          icon="target"
          title={filter === 'all' ? 'No missions yet' : `No ${filter} missions`}
          body={
            filter === 'all'
              ? 'Launch your first mission from the Dashboard and it will show up here.'
              : 'Try a different filter to see the rest of the history.'
          }
          action={
            filter === 'all' ? (
              <LinkButton href={href({ name: 'dashboard' })} variant="primary">
                Launch a mission
              </LinkButton>
            ) : undefined
          }
        />
      ) : visible.length === 0 ? (
        <EmptyState
          icon="search"
          title="No matches"
          body={`Nothing in the loaded missions matches “${query.trim()}”.`}
        />
      ) : (
        <>
          <p className="tabular text-[0.72rem] uppercase tracking-[0.14em] text-[var(--color-ink-faint)]">
            {needle === ''
              ? `${missions.data?.total ?? items.length} mission${(missions.data?.total ?? items.length) === 1 ? '' : 's'}`
              : `${visible.length} of ${items.length} shown`}
          </p>
          <div className="acc-stagger grid grid-cols-1 gap-2 lg:grid-cols-2">
            {visible.map((summary) => (
              <MissionCard key={summary.id} summary={summary} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
