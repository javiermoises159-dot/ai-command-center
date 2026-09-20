import { Icon } from '../components/icons.tsx';
import { Badge, EmptyState, ErrorBanner, IconTile, PageHeader, Panel, Skeleton, StatusChip } from '../components/primitives.tsx';
import { useAgentCatalog } from '../hooks/useApi.ts';
import { RegistryAgents } from '../components/madre/RegistryAgents.tsx';
import { useRecentMissions } from '../hooks/useRecentMissions.ts';
import { agentMeta } from '../lib/agents-meta.ts';
import { deriveCrewState, emptyCrewState, type CrewMemberState } from '../lib/crew.ts';
import { cleanPrompt, cx, duration, relativeTime } from '../lib/format.ts';
import { href } from '../lib/router.tsx';
import { t } from '../i18n/index.ts';
import type { AgentDefinition } from '../lib/api.ts';

const RECENT_LIMIT = 20;

export function AgentsPage() {
  const catalog = useAgentCatalog();
  const recent = useRecentMissions(RECENT_LIMIT);
  const crew = deriveCrewState(recent.missions);

  return (
    <div className="space-y-5">
      <PageHeader
        icon="bot"
        title={t.agents.title}
        description={t.agents.description}
      />

      {recent.error !== null && <ErrorBanner message={recent.error} onRetry={recent.refresh} />}

      {catalog.length === 0 ? (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2" role="status" aria-label={t.agents.loadingAria}>
          {Array.from({ length: 4 }, (_, i) => (
            <Panel key={i} className="space-y-3 p-4">
              <Skeleton className="h-10 w-10 rounded-xl" />
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-4/5" />
            </Panel>
          ))}
        </div>
      ) : (
        <>
          <p className="tabular text-[0.72rem] uppercase tracking-[0.14em] text-[var(--color-ink-faint)]">
            {t.agents.summary(catalog.length)}
            {recent.live && <span className="ml-2 text-[var(--color-signal)]">● {t.agents.live}</span>}
          </p>
          <div className="acc-stagger grid grid-cols-1 gap-3 md:grid-cols-2">
            {catalog.map((agent, index) => (
              <AgentCard
                key={agent.id}
                position={index + 1}
                agent={agent}
                state={crew.get(agent.id) ?? emptyCrewState()}
                loading={recent.loading}
              />
            ))}
          </div>
          <RegistryAgents />
          {recent.missions.length === 0 && !recent.loading && (
            <EmptyState
              icon="play"
              title={t.agents.empty.title}
              body={t.agents.empty.body}
            />
          )}
        </>
      )}
    </div>
  );
}

function AgentCard({
  agent,
  state,
  loading,
  position,
}: {
  agent: AgentDefinition;
  state: CrewMemberState;
  loading: boolean;
  position: number;
}) {
  const meta = agentMeta(agent.id);
  const runs = state.completed + state.failed;

  return (
    <Panel as="article" className={cx('p-4', state.working !== null && 'border-cyan-500/40')}>
      <div className="flex items-start gap-3.5">
        <IconTile icon={meta.icon} accent={agent.accent} size="lg" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h2 className="text-base font-semibold text-[var(--color-ink)]">{agent.name}</h2>
            <code className="rounded bg-[var(--color-tint)] px-1.5 py-0.5 font-mono text-[0.68rem] text-[var(--color-ink-faint)]">
              {agent.id}
            </code>
            {agent.kind !== 'worker' && <Badge tone="signal">{t.agents.kind[agent.kind] ?? agent.kind}</Badge>}
          </div>
          <p className="mt-1 text-[0.82rem] text-[var(--color-ink-dim)]">{agent.role}</p>
        </div>
        <span className="tabular shrink-0 text-[0.7rem] text-[var(--color-ink-faint)]">#{position}</span>
      </div>

      <p className="mt-3 text-[0.8rem] leading-relaxed text-[var(--color-ink-faint)]">
        <span className="font-medium text-[var(--color-ink-dim)]">{t.agents.delivers}</span>
        {agent.deliverable}
      </p>

      {meta.capabilities.length > 0 && (
        <ul className="mt-3 flex flex-wrap gap-1.5" aria-label={t.agents.capabilitiesAria(agent.name)}>
          {meta.capabilities.map((capability) => (
            <li
              key={capability}
              className="rounded-full bg-[var(--color-tint)] px-2.5 py-1 text-[0.7rem] text-[var(--color-ink-dim)] ring-1 ring-[var(--color-line)]"
            >
              {capability}
            </li>
          ))}
        </ul>
      )}

      {/* ---------------------------------------------------------- Live state */}
      <div className="mt-4 border-t border-[var(--color-edge)] pt-3">
        {loading ? (
          <Skeleton className="h-5 w-2/3" />
        ) : state.working !== null ? (
          <div className="flex flex-wrap items-center gap-2 text-[0.78rem]">
            <StatusChip status="running" />
            <span className="text-[var(--color-ink-faint)]">{t.agents.state.on}</span>
            <a
              href={href({ name: 'mission', id: state.working.missionId })}
              className="min-w-0 truncate font-medium text-[var(--color-signal)] hover:underline"
            >
              {cleanPrompt(state.working.missionTitle)}
            </a>
          </div>
        ) : state.last !== null ? (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.78rem] text-[var(--color-ink-faint)]">
            <Badge>{t.agents.state.idle}</Badge>
            <span>{t.agents.state.lastRun}</span>
            <StatusChip status={state.last.status} />
            <a
              href={href({ name: 'mission', id: state.last.missionId })}
              className="hover:text-[var(--color-ink-dim)] hover:underline"
            >
              {relativeTime(state.last.at)}
            </a>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-[0.78rem] text-[var(--color-ink-faint)]">
            <Badge tone="ok">{t.agents.state.ready}</Badge>
            <span>{t.agents.state.neverRun}</span>
          </div>
        )}

        <dl className="tabular mt-3 grid grid-cols-3 gap-2 text-center">
          <Metric label={t.agents.metrics.done} value={loading ? '…' : String(state.completed)} tone="ok" />
          <Metric label={t.agents.metrics.failed} value={loading ? '…' : String(state.failed)} tone={state.failed > 0 ? 'bad' : 'neutral'} />
          <Metric
            label={t.agents.metrics.avgTime}
            value={loading ? '…' : runs === 0 || state.avgDurationMs === null ? '—' : duration(state.avgDurationMs)}
            tone="neutral"
          />
        </dl>
      </div>
      <p className="mt-2.5 flex items-center gap-1.5 text-[0.66rem] text-[var(--color-ink-faint)]">
        <Icon name="clock" className="h-3 w-3" />
        {t.agents.countedOver(RECENT_LIMIT)}
      </p>
    </Panel>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone: 'ok' | 'bad' | 'neutral' }) {
  return (
    <div className="rounded-lg bg-[var(--color-tint)] px-2 py-2">
      <dd
        className={cx(
          'text-base font-semibold',
          tone === 'ok' && 'text-[var(--color-ok)]',
          tone === 'bad' && 'text-[var(--color-bad)]',
          tone === 'neutral' && 'text-[var(--color-ink)]',
        )}
      >
        {value}
      </dd>
      <dt className="mt-0.5 text-[0.6rem] uppercase tracking-wider text-[var(--color-ink-faint)]">{label}</dt>
    </div>
  );
}
