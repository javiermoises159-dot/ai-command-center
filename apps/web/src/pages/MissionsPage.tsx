import { useState } from 'react';

import { Icon } from '../components/icons.tsx';
import { MissionCard } from '../components/MissionCard.tsx';
import { EmptyState, ErrorBanner, LinkButton, ListSkeleton, PageHeader, Segmented } from '../components/primitives.tsx';
import { cleanPrompt } from '../lib/format.ts';
import { href } from '../lib/router.tsx';
import { t } from '../i18n/index.ts';
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
    { value: 'all', label: t.missions.list.filters.all, ...(stats.data ? { count: stats.data.total } : {}) },
    { value: 'running', label: t.missions.list.filters.running, ...(stats.data ? { count: stats.data.running } : {}) },
    { value: 'completed', label: t.missions.list.filters.completed, ...(stats.data ? { count: stats.data.completed } : {}) },
    { value: 'failed', label: t.missions.list.filters.failed, ...(stats.data ? { count: stats.data.failed } : {}) },
  ];

  return (
    <div className="space-y-5">
      <PageHeader
        icon="target"
        title={t.missions.list.title}
        description={t.missions.list.description}
        actions={
          <LinkButton href={href({ name: 'dashboard' })} variant="primary">
            <Icon name="plus" className="h-4 w-4" />
            {t.missions.list.newMission}
          </LinkButton>
        }
      />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Segmented label={t.missions.list.filterAria} value={filter} onChange={setFilter} options={options} />

        <div className="relative sm:w-64">
          <Icon
            name="search"
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-ink-faint)]"
          />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t.missions.list.searchLabel}
            aria-label={t.missions.list.searchLabel}
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
          title={filter === 'all' ? t.missions.list.emptyAll : t.missions.list.emptyFiltered(filter)}
          body={
            filter === 'all'
              ? t.missions.list.emptyAllBody
              : t.missions.list.emptyFilteredBody
          }
          action={
            filter === 'all' ? (
              <LinkButton href={href({ name: 'dashboard' })} variant="primary">
                {t.missions.list.launch}
              </LinkButton>
            ) : undefined
          }
        />
      ) : visible.length === 0 ? (
        <EmptyState
          icon="search"
          title={t.missions.list.noMatches}
          body={t.missions.list.noMatchesBody(query.trim())}
        />
      ) : (
        <>
          <p className="tabular text-[0.72rem] uppercase tracking-[0.14em] text-[var(--color-ink-faint)]">
            {needle === ''
              ? t.missions.list.total(missions.data?.total ?? items.length)
              : t.missions.list.shownOf(visible.length, items.length)}
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
