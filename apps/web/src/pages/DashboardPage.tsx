import { MissionCard } from '../components/MissionCard.tsx';
import { MissionForm } from '../components/MissionForm.tsx';
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
          AI Command Center
        </p>
        <h1 className="mb-4 text-[1.7rem] font-semibold leading-tight tracking-tight text-[var(--color-ink)] sm:text-4xl">
          ¿Qué quieres conseguir hoy?
        </h1>
        <MissionForm onCreated={missions.refresh} />
      </section>

      {/* -------------------------------------------------------------- Stats */}
      <section aria-label="Mission statistics" className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <Stat label="Missions" value={stats.data?.total ?? '—'} loading={statsLoading} />
        <Stat
          label="Active"
          value={(stats.data?.running ?? 0) + (stats.data?.pending ?? 0)}
          tone="signal"
          loading={statsLoading}
        />
        <Stat label="Completed" value={stats.data?.completed ?? '—'} tone="ok" loading={statsLoading} />
        <Stat label="Failed" value={stats.data?.failed ?? '—'} tone="bad" loading={statsLoading} />
      </section>

      <div className="grid grid-cols-1 gap-7 lg:grid-cols-[minmax(0,1fr)_20rem]">
        {/* --------------------------------------------------- Recent missions */}
        <section>
          <SectionTitle
            action={
              recent.length > 0 ? (
                <a href={href({ name: 'missions' })} className="text-[0.74rem] font-medium text-[var(--color-signal)] hover:underline">
                  View all →
                </a>
              ) : undefined
            }
          >
            Recent missions
          </SectionTitle>

          {missions.error !== null && recent.length === 0 ? (
            <ErrorBanner message={missions.error} onRetry={missions.refresh} />
          ) : missions.loading && recent.length === 0 ? (
            <ListSkeleton rows={3} />
          ) : recent.length === 0 ? (
            <EmptyState
              icon="target"
              title="No missions yet"
              body="Write a mission above and press “Ejecutar misión”. The crew will break it into work and you will see each agent report back here."
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
                  Details →
                </a>
              }
            >
              Agents available
            </SectionTitle>
            <Panel className="divide-y divide-[var(--color-edge)]">
              {catalog.length === 0 && (
                <div className="space-y-3 p-3.5" role="status" aria-label="Loading agents">
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
                  <Badge tone="ok">Ready</Badge>
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

  const rows: { label: string; value: string; tone?: 'ok' | 'bad' | 'warn' }[] = online
    ? [
        { label: 'API', value: `Online · ${health.data?.latencyMs ?? 0} ms`, tone: 'ok' },
        { label: 'Version', value: `v${health.data?.health.version}` },
        {
          label: 'Provider',
          value: health.data?.health.provider ?? 'none',
          tone: health.data?.health.provider === 'mock' ? 'warn' : undefined,
        },
        { label: 'Active missions', value: String(activeMissions) },
        { label: 'Checked', value: relativeTime(health.data?.health.time ?? null) },
      ]
    : [];

  return (
    <section>
      <SectionTitle>System status</SectionTitle>
      <Panel className="p-3.5">
        {checking ? (
          <div className="space-y-2.5" role="status" aria-label="Checking system status">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-4 w-full" />
            ))}
          </div>
        ) : !online ? (
          <div className="flex items-start gap-2.5 text-[0.82rem] text-[var(--color-bad)]" role="alert">
            <span className="mt-1 inline-block h-2.5 w-2.5 shrink-0 rounded-full bg-[var(--color-bad)]" aria-hidden />
            <div>
              <p className="font-medium">API unreachable</p>
              <p className="mt-0.5 text-[var(--color-ink-faint)]">{health.error ?? 'Is the server running?'}</p>
            </div>
          </div>
        ) : (
          <dl className="space-y-2.5 text-[0.8rem]">
            {rows.map((row) => (
              <div key={row.label} className="flex items-center justify-between gap-3">
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
                  {row.label === 'API' && <span className="h-2 w-2 rounded-full bg-[var(--color-ok)]" aria-hidden />}
                  {row.value}
                </dd>
              </div>
            ))}
          </dl>
        )}
        {online && health.data?.health.provider === 'mock' && (
          <p className="mt-3 border-t border-[var(--color-edge)] pt-3 text-[0.72rem] leading-relaxed text-[var(--color-ink-faint)]">
            Running on the simulated provider. Output is structurally real but carries no analysis.
          </p>
        )}
      </Panel>
    </section>
  );
}
