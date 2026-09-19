import { MissionCard } from '../components/MissionCard.tsx';
import { MissionForm } from '../components/MissionForm.tsx';
import { EmptyState, ErrorBanner, Panel, SectionTitle, Stat } from '../components/primitives.tsx';
import { accentClass, cx } from '../lib/format.ts';
import { href } from '../lib/router.tsx';
import { useAgentCatalog, useMissions, useStats } from '../hooks/useApi.ts';

export function DashboardPage() {
  const catalog = useAgentCatalog();
  const missions = useMissions({ limit: 5 });
  const hasActive = (missions.data?.items ?? []).some(
    (m) => m.status === 'running' || m.status === 'pending',
  );
  const stats = useStats(hasActive);

  const recent = missions.data?.items ?? [];

  return (
    <div className="space-y-6">
      <section>
        <div className="grid grid-cols-4 gap-2">
          <Stat label="Total" value={stats.data?.total ?? '—'} />
          <Stat label="Active" value={(stats.data?.running ?? 0) + (stats.data?.pending ?? 0)} tone="signal" />
          <Stat label="Done" value={stats.data?.completed ?? '—'} tone="ok" />
          <Stat label="Failed" value={stats.data?.failed ?? '—'} tone="bad" />
        </div>
      </section>

      <MissionForm onCreated={missions.refresh} />

      <section>
        <SectionTitle
          action={
            recent.length > 0 ? (
              <a href={href({ name: 'missions' })} className="text-[0.72rem] text-[var(--color-signal)]">
                View all
              </a>
            ) : undefined
          }
        >
          Recent missions
        </SectionTitle>

        {missions.error !== null && recent.length === 0 ? (
          <ErrorBanner message={missions.error} onRetry={missions.refresh} />
        ) : recent.length === 0 && !missions.loading ? (
          <EmptyState
            title="No missions yet"
            body="Write a mission above and the crew will break it into work."
          />
        ) : (
          <div className="space-y-2">
            {recent.map((summary) => (
              <MissionCard key={summary.id} summary={summary} />
            ))}
          </div>
        )}
      </section>

      <section>
        <SectionTitle>The crew</SectionTitle>
        <Panel className="divide-y divide-[var(--color-edge)]">
          {catalog.map((agent, index) => (
            <div key={agent.id} className="flex items-center gap-3 px-3.5 py-2.5">
              <span
                className={cx(
                  'grid h-7 w-7 shrink-0 place-items-center rounded-lg text-[0.65rem] font-semibold ring-1',
                  accentClass(agent.accent),
                )}
              >
                {index + 1}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[0.82rem] font-medium text-[var(--color-ink)]">{agent.name}</p>
                <p className="truncate text-[0.7rem] text-[var(--color-ink-faint)]">{agent.role}</p>
              </div>
              {agent.kind !== 'worker' && (
                <span className="shrink-0 rounded-full bg-white/5 px-2 py-0.5 text-[0.6rem] uppercase tracking-wider text-[var(--color-ink-faint)] ring-1 ring-white/10">
                  {agent.kind}
                </span>
              )}
            </div>
          ))}
          {catalog.length === 0 && (
            <p className="px-3.5 py-4 text-[0.8rem] text-[var(--color-ink-faint)]">Loading the agent catalog…</p>
          )}
        </Panel>
      </section>
    </div>
  );
}
