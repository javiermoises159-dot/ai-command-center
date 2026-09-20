import { useMemo, useState } from 'react';

import { Icon } from '../components/icons.tsx';
import { Badge, EmptyState, ErrorBanner, ListSkeleton, Notice, PageHeader, Panel, SectionTitle } from '../components/primitives.tsx';
import { useMadreTools } from '../hooks/useMadre.ts';
import { useRecentMissions } from '../hooks/useRecentMissions.ts';
import { t } from '../i18n/index.ts';
import { absoluteTime, cleanPrompt, cx, excerpt } from '../lib/format.ts';
import { Markdown } from '../lib/markdown.tsx';
import { href } from '../lib/router.tsx';

/**
 * Research shows what the Research agent actually wrote for your missions, and
 * says plainly whether live sources were available. When web search is not
 * connected the findings come from the model's own knowledge: they are leads to
 * check, not verified facts, and every one of them is labelled that way.
 */

export function ResearchPage() {
  const recent = useRecentMissions(20);
  const tools = useMadreTools();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const copy = t.research;

  const search = tools.data?.items.find((tool) => tool.id === 'web.search') ?? null;
  const searchConnected = search !== null && (search.status === 'AVAILABLE' || search.status === 'CONNECTED');

  const findings = useMemo(
    () =>
      recent.missions.flatMap((mission) => {
        const agent = mission.runs[0]?.agents.find((a) => a.agentId === 'research' && a.status === 'completed');
        return agent?.result != null
          ? [{ id: mission.id, title: mission.title, text: agent.result, at: agent.completedAt ?? mission.updatedAt, provider: agent.usage?.provider ?? null }]
          : [];
      }),
    [recent.missions],
  );
  const selected = findings.find((f) => f.id === selectedId) ?? findings[0];

  return (
    <div className="space-y-5">
      <PageHeader icon="search" title={copy.title} description={copy.description} />

      {tools.data !== null && (
        <Notice tone={searchConnected ? 'live' : 'mock'} title={searchConnected ? copy.notice.connectedTitle : copy.notice.disconnectedTitle}>
          {searchConnected ? copy.notice.connectedBody : copy.notice.disconnectedBody}
        </Notice>
      )}

      {recent.error !== null && recent.missions.length === 0 ? (
        <ErrorBanner message={recent.error} onRetry={recent.refresh} />
      ) : recent.loading && recent.missions.length === 0 ? (
        <ListSkeleton rows={3} />
      ) : findings.length === 0 ? (
        <EmptyState icon="search" title={copy.empty.title} body={copy.empty.body} />
      ) : (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[18rem_minmax(0,1fr)]">
          <section aria-label={copy.missionsAria} className="space-y-2">
            <SectionTitle>{copy.fromMissions}</SectionTitle>
            <ul className="space-y-1.5">
              {findings.map((f) => {
                const active = f.id === selected?.id;
                return (
                  <li key={f.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(f.id)}
                      aria-pressed={active}
                      className={cx('w-full rounded-xl px-3.5 py-3 text-left transition', active ? 'bg-[var(--color-signal)]/12 ring-1 ring-[var(--color-signal)]/40' : 'panel hover:bg-[var(--color-tint)]')}
                    >
                      <span className="block text-[0.86rem] font-medium leading-snug text-[var(--color-ink)]">{cleanPrompt(f.title)}</span>
                      <span className="mt-1 line-clamp-2 block text-[0.74rem] text-[var(--color-ink-faint)]">{excerpt(f.text, 110)}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>

          {selected !== undefined && (
            <section aria-label={copy.findingAria} className="min-w-0 space-y-3">
              <Panel className="p-4 sm:p-5">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <h2 className="min-w-0 flex-1 text-base font-semibold text-[var(--color-ink)]">{cleanPrompt(selected.title)}</h2>
                  <div className="flex gap-1.5">
                    <Badge tone={searchConnected ? 'ok' : 'warn'}>{searchConnected ? copy.badges.live : copy.badges.unverified}</Badge>
                    {selected.provider === 'mock' && <Badge tone="warn">{copy.badges.simulated}</Badge>}
                  </div>
                </div>
                <p className="mt-1 text-[0.7rem] text-[var(--color-ink-faint)]">{absoluteTime(selected.at)}</p>
                <div className="mt-3">
                  <Markdown source={selected.text} />
                </div>
                <a href={href({ name: 'mission', id: selected.id })} className="mt-4 inline-flex min-h-[44px] items-center gap-1.5 text-[0.8rem] font-medium text-[var(--color-signal)] hover:underline">
                  {copy.openMission}
                  <Icon name="arrow-right" className="h-4 w-4" />
                </a>
              </Panel>
            </section>
          )}
        </div>
      )}

      <section>
        <SectionTitle>{copy.labelsTitle}</SectionTitle>
        <Panel className="divide-y divide-[var(--color-edge)]">
          {copy.labels.map((l) => (
            <div key={l.label} className="flex items-baseline gap-3 px-4 py-2.5">
              <Badge className="w-28 justify-center">{l.label}</Badge>
              <p className="text-[0.8rem] text-[var(--color-ink-dim)]">{l.body}</p>
            </div>
          ))}
        </Panel>
      </section>
    </div>
  );
}
