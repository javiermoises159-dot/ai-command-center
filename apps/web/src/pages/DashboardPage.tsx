import { MissionCard } from '../components/MissionCard.tsx';
import { MissionForm } from '../components/MissionForm.tsx';
import { CommandCenter } from '../components/madre/CommandCenter.tsx';
import { Icon } from '../components/icons.tsx';
import {
  Badge,
  EmptyState,
  ErrorBanner,
  IconTile,
  ListSkeleton,
  Panel,
  SectionTitle,
  Skeleton,
  Stat,
} from '../components/primitives.tsx';
import { agentMeta } from '../lib/agents-meta.ts';
import { cx, relativeTime } from '../lib/format.ts';
import { href } from '../lib/router.tsx';
import { t } from '../i18n/index.ts';
import { useAgentCatalog, useHealth, useMissions, useStats } from '../hooks/useApi.ts';

export function DashboardPage() {
  const catalog = useAgentCatalog();
  const missions = useMissions({ limit: 5 });
  const hasActive = (missions.data?.items ?? []).some((m) => m.status === 'running' || m.status === 'pending');
  const stats = useStats(hasActive);

  const recent = missions.data?.items ?? [];
  const statsLoading = stats.data === null && stats.error === null;

  return (
    <div className="acc-stagger space-y-7">
      {/* ------------------------------------------------------------ Command */}
      <section>
        <p className="mb-2 flex items-center gap-2 text-[0.72rem] font-semibold uppercase tracking-[0.2em] text-[var(--color-signal)]">
          <Icon name="sparkles" className="h-3.5 w-3.5" />
          {t.common.appName}
        </p>
        <h1 className="mb-4 text-[1.7rem] font-semibold leading-tight tracking-tight text-[var(--color-ink)] sm:text-4xl">
          {t.dashboard.heading}
        </h1>
        <MissionForm onCreated={missions.refresh} />
      </section>

      <CommandCenter missions={recent} />

      {/* -------------------------------------------------------------- Stats */}
      <section aria-label={t.dashboard.stats.ariaLabel} className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <Stat label={t.dashboard.stats.missions} value={stats.data?.total ?? '—'} loading={statsLoading} />
        <Stat
          label={t.dashboard.stats.active}
          value={(stats.data?.running ?? 0) + (stats.data?.pending ?? 0)}
          tone="signal"
          loading={statsLoading}
        />
        <Stat label={t.dashboard.stats.completed} value={stats.data?.completed ?? '—'} tone="ok" loading={statsLoading} />
        <Stat label={t.dashboard.stats.failed} value={stats.data?.failed ?? '—'} tone="bad" loading={statsLoading} />
      </section>

      <div className="grid grid-cols-1 gap-7 lg:grid-cols-[minmax(0,1fr)_20rem]">
        {/* --------------------------------------------------- Recent missions */}
        <section>
          <SectionTitle
            action={
              recent.length > 0 ? (
                <a href={href({ name: 'missions' })} className="text-[0.74rem] font-medium text-[var(--color-signal)] hover:underline">
                  {t.dashboard.recent.viewAll}
                </a>
              ) : undefined
            }
          >
            {t.dashboard.recent.title}
          </SectionTitle>

          {missions.error !== null && recent.length === 0 ? (
            <ErrorBanner message={missions.error} onRetry={missions.refresh} />
          ) : missions.loading && recent.length === 0 ? (
            <ListSkeleton rows={3} />
          ) : recent.length === 0 ? (
            <EmptyState
              icon="target"
              title={t.dashboard.recent.emptyTitle}
              body={t.dashboard.recent.emptyBody}
            />
          ) : (
            <div className="space-y-2">
              {recent.map((summary) => (
                <MissionCard key={summary.id} summary={summary} />
              ))}
            </div>
          )}
        </section>

        {/* --------------------------------------------------------- Sidebar */}
        <div className="space-y-7">
          <SystemStatusPanel activeMissions={(stats.data?.running ?? 0) + (stats.data?.pending ?? 0)} />

          <section>
            <SectionTitle
              action={
                <a href={href({ name: 'agents' })} className="text-[0.74rem] font-medium text-[var(--color-signal)] hover:underline">
                  {t.dashboard.agents.details}
                </a>
              }
            >
              {t.dashboard.agents.title}
            </SectionTitle>
            <Panel className="divide-y divide-[var(--color-edge)]">
              {catalog.length === 0 && (
                <div className="space-y-3 p-3.5" role="status" aria-label={t.dashboard.agents.loading}>
                  {Array.from({ length: 4 }, (_, i) => (
                    <Skeleton key={i} className="h-8 w-full" />
                  ))}
                </div>
              )}
              {catalog.map((agent) => (
                <div key={agent.id} className="flex items-center gap-3 px-3.5 py-2.5">
                  <IconTile icon={agentMeta(agent.id).icon} accent={agent.accent} size="sm" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[0.82rem] font-medium text-[var(--color-ink)]">{agent.name}</p>
                    <p className="truncate text-[0.7rem] text-[var(--color-ink-faint)]">{agent.role}</p>
                  </div>
                  <Badge tone="ok">{t.dashboard.agents.ready}</Badge>
                </div>
              ))}
            </Panel>
          </section>
        </div>
      </div>
    </div>
  );
}

/** Live readout of the API, from real requests to /api/health and /api/stats. */
function SystemStatusPanel({ activeMissions }: { activeMissions: number }) {
  const health = useHealth();
  const checking = health.data === null && health.error === null;
  const online = health.data !== null && health.error === null;

  const rows: { id: string; label: string; value: string; tone?: 'ok' | 'bad' | 'warn' }[] = online
    ? [
        { id: 'api', label: t.dashboard.system.api, value: t.dashboard.system.online(health.data?.latencyMs ?? 0), tone: 'ok' },
        { id: 'version', label: t.dashboard.system.version, value: `v${health.data?.health.version}` },
        {
          id: 'provider',
          label: t.dashboard.system.provider,
          value: t.dashboard.system.providerName(health.data?.health.provider ?? null),
          tone: health.data?.health.provider === 'mock' ? 'warn' : undefined,
        },
        { id: 'active', label: t.dashboard.system.activeMissions, value: String(activeMissions) },
        { id: 'checked', label: t.dashboard.system.checked, value: relativeTime(health.data?.health.time ?? null) },
      ]
    : [];

  return (
    <section>
      <SectionTitle>{t.dashboard.system.title}</SectionTitle>
      <Panel className="p-3.5">
        {checking ? (
          <div className="space-y-2.5" role="status" aria-label={t.dashboard.system.checking}>
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-4 w-full" />
            ))}
          </div>
        ) : !online ? (
          <div className="flex items-start gap-2.5 text-[0.82rem] text-[var(--color-bad)]" role="alert">
            <span className="mt-1 inline-block h-2.5 w-2.5 shrink-0 rounded-full bg-[var(--color-bad)]" aria-hidden />
            <div>
              <p className="font-medium">{t.dashboard.system.unreachable}</p>
              <p className="mt-0.5 text-[var(--color-ink-faint)]">{health.error ?? t.dashboard.system.unreachableHint}</p>
            </div>
          </div>
        ) : (
          <dl className="space-y-2.5 text-[0.8rem]">
            {rows.map((row) => (
              <div key={row.id} className="flex items-center justify-between gap-3">
                <dt className="text-[var(--color-ink-faint)]">{row.label}</dt>
                <dd
                  className={cx(
                    'tabular flex items-center gap-2 font-medium',
                    row.tone === 'ok' && 'text-[var(--color-ok)]',
                    row.tone === 'bad' && 'text-[var(--color-bad)]',
                    row.tone === 'warn' && 'text-[var(--color-warn)]',
                    row.tone === undefined && 'text-[var(--color-ink)]',
                  )}
                >
                  {row.id === 'api' && <span className="h-2 w-2 rounded-full bg-[var(--color-ok)]" aria-hidden />}
                  {row.value}
                </dd>
              </div>
            ))}
          </dl>
        )}
        {online && health.data?.health.provider === 'mock' && (
          <p className="mt-3 border-t border-[var(--color-edge)] pt-3 text-[0.72rem] leading-relaxed text-[var(--color-ink-faint)]">
            {t.dashboard.system.simulatedNote}
          </p>
        )}
      </Panel>
    </section>
  );
}
