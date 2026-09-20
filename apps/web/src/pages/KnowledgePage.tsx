import { Fragment, useMemo, useState, type ReactNode } from 'react';

import { Icon, type IconName } from '../components/icons.tsx';
import {
  Badge,
  Button,
  EmptyState,
  ErrorBanner,
  ListSkeleton,
  Notice,
  PageHeader,
  Panel,
  Segmented,
  Stat,
} from '../components/primitives.tsx';
import { useRecentMissions } from '../hooks/useRecentMissions.ts';
import { MemoryPanel } from '../components/madre/MemoryPanel.tsx';
import { LOCALE, t } from '../i18n/index.ts';
import { absoluteTime, cleanPrompt, excerpt } from '../lib/format.ts';
import { href } from '../lib/router.tsx';
import type { MissionDetail } from '../lib/api.ts';

type Tab = 'memory' | 'collections' | 'documents' | 'sources' | 'search';

const TABS: readonly { value: Tab; label: string }[] = [
  { value: 'memory', label: t.knowledge.tabs.memory },
  { value: 'collections', label: t.knowledge.tabs.collections },
  { value: 'documents', label: t.knowledge.tabs.documents },
  { value: 'sources', label: t.knowledge.tabs.sources },
  { value: 'search', label: t.knowledge.tabs.search },
];

/** A piece of text the app already holds and can search. */
interface Entry {
  key: string;
  missionId: string;
  missionTitle: string;
  /** Whether this is a mission's final brief or one agent's individual result. */
  kind: 'brief' | 'output';
  /** Text shown as the origin: "Brief final" or the name of the agent that wrote it. */
  origin: string;
  text: string;
  at: string;
}

/**
 * Knowledge is built only from what really exists today: the final briefs of
 * your missions and the individual results of each agent's latest run. There is
 * no upload, index or embedding store yet, and the screen says so.
 */
function collectEntries(missions: readonly MissionDetail[]): { briefs: Entry[]; outputs: Entry[] } {
  const briefs: Entry[] = [];
  const outputs: Entry[] = [];

  for (const mission of missions) {
    if (mission.finalResult !== null) {
      briefs.push({
        key: `${mission.id}:brief`,
        missionId: mission.id,
        missionTitle: mission.title,
        kind: 'brief',
        origin: t.knowledge.origin.finalBrief,
        text: mission.finalResult,
        at: mission.updatedAt,
      });
    }
    const latest = mission.runs[0];
    for (const agent of latest?.agents ?? []) {
      if (agent.result !== null) {
        outputs.push({
          key: agent.id,
          missionId: mission.id,
          missionTitle: mission.title,
          kind: 'output',
          origin: agent.name,
          text: agent.result,
          at: agent.completedAt ?? mission.updatedAt,
        });
      }
    }
  }
  return { briefs, outputs };
}

export function KnowledgePage() {
  const recent = useRecentMissions(30);
  const [tab, setTab] = useState<Tab>('memory');

  const { briefs, outputs } = useMemo(() => collectEntries(recent.missions), [recent.missions]);

  return (
    <div className="space-y-5">
      <PageHeader icon="database" title={t.knowledge.title} description={t.knowledge.description} />

      <Notice tone="live" title={t.knowledge.notice.title}>
        {t.knowledge.notice.body}
      </Notice>

      <Segmented label={t.knowledge.sectionsAria} value={tab} onChange={setTab} options={TABS} />

      {tab === 'memory' ? (
        <div className="acc-fade">
          <MemoryPanel />
        </div>
      ) : recent.error !== null && recent.missions.length === 0 ? (
        <ErrorBanner message={recent.error} onRetry={recent.refresh} />
      ) : recent.loading && recent.missions.length === 0 ? (
        <ListSkeleton rows={3} />
      ) : (
        <div key={tab} className="acc-fade">
          {tab === 'collections' && <Collections briefs={briefs} outputs={outputs} onOpenDocuments={() => setTab('documents')} />}
          {tab === 'documents' && <Documents briefs={briefs} />}
          {tab === 'sources' && <Sources />}
          {tab === 'search' && <SearchPanel entries={[...briefs, ...outputs]} />}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function Collections({ briefs, outputs, onOpenDocuments }: { briefs: Entry[]; outputs: Entry[]; onOpenDocuments: () => void }) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
        <Stat label={t.knowledge.collections.finalBriefs} value={briefs.length} tone="ok" />
        <Stat label={t.knowledge.collections.agentOutputs} value={outputs.length} tone="signal" />
        <Stat label={t.knowledge.collections.sources} value={0} />
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <CollectionCard
          icon="file-text"
          title={t.knowledge.collections.briefsTitle}
          body={t.knowledge.collections.briefsBody}
          count={briefs.length}
          action={
            briefs.length > 0 ? (
              <Button variant="ghost" onClick={onOpenDocuments}>
                {t.knowledge.collections.viewDocuments}
                <Icon name="arrow-right" className="h-4 w-4" />
              </Button>
            ) : undefined
          }
        />
        <CollectionCard
          icon="bot"
          title={t.knowledge.collections.outputsTitle}
          body={t.knowledge.collections.outputsBody}
          count={outputs.length}
        />
      </div>

      {briefs.length === 0 && (
        <EmptyState icon="database" title={t.knowledge.collections.empty.title} body={t.knowledge.collections.empty.body} />
      )}
    </div>
  );
}

function CollectionCard({
  icon,
  title,
  body,
  count,
  action,
}: {
  icon: IconName;
  title: string;
  body: string;
  count: number;
  action?: ReactNode;
}) {
  return (
    <Panel as="article" className="flex flex-col p-4">
      <div className="flex items-start gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[var(--color-signal)]/12 text-[var(--color-signal)] ring-1 ring-[var(--color-signal)]/25">
          <Icon name={icon} className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-[0.95rem] font-semibold text-[var(--color-ink)]">{title}</h2>
          <p className="tabular text-[0.72rem] text-[var(--color-ink-faint)]">{t.knowledge.collections.count(count)}</p>
        </div>
      </div>
      <p className="mt-3 flex-1 text-[0.8rem] leading-relaxed text-[var(--color-ink-dim)]">{body}</p>
      {action !== undefined && <div className="mt-3">{action}</div>}
    </Panel>
  );
}

function Documents({ briefs }: { briefs: Entry[] }) {
  if (briefs.length === 0) {
    return <EmptyState icon="file-text" title={t.knowledge.documents.empty.title} body={t.knowledge.documents.empty.body} />;
  }

  const number = new Intl.NumberFormat(LOCALE);

  return (
    <ul className="space-y-2">
      {briefs.map((entry) => (
        <li key={entry.key}>
          <a
            href={href({ name: 'mission', id: entry.missionId })}
            className="panel flex items-start gap-3 px-4 py-3 transition hover:border-[var(--color-edge-bright)] hover:bg-[var(--color-surface-2)]/60"
          >
            <Icon name="file-text" className="mt-0.5 h-5 w-5 shrink-0 text-[var(--color-ok)]" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[0.9rem] font-medium text-[var(--color-ink)]">
                {cleanPrompt(entry.missionTitle)}
              </span>
              <span className="mt-0.5 line-clamp-2 text-[0.78rem] text-[var(--color-ink-dim)]">{excerpt(entry.text, 200)}</span>
              <span className="tabular mt-1 block text-[0.68rem] text-[var(--color-ink-faint)]">
                {t.knowledge.documents.meta(entry.origin, number.format(entry.text.length), absoluteTime(entry.at))}
              </span>
            </span>
            <Icon name="chevron-right" className="mt-1 h-4 w-4 shrink-0 text-[var(--color-ink-faint)]" />
          </a>
        </li>
      ))}
    </ul>
  );
}

function Sources() {
  return (
    <div className="space-y-4">
      <EmptyState icon="link" title={t.knowledge.sources.empty.title} body={t.knowledge.sources.empty.body} />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {t.knowledge.sources.planned.map((source) => (
          <Panel key={source.name} as="article" className="flex items-start gap-3 p-4">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[var(--color-tint)] text-[var(--color-ink-faint)] ring-1 ring-[var(--color-line)]">
              <Icon name={source.icon} className="h-5 w-5" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-[0.9rem] font-medium text-[var(--color-ink)]">{source.name}</h3>
                <Badge>{t.knowledge.sources.notConnected}</Badge>
              </div>
              <p className="mt-1 text-[0.78rem] leading-relaxed text-[var(--color-ink-faint)]">{source.body}</p>
            </div>
          </Panel>
        ))}
      </div>
    </div>
  );
}

const MIN_QUERY = 2;
const MAX_RESULTS = 25;

function SearchPanel({ entries }: { entries: Entry[] }) {
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();

  const results = useMemo(() => {
    if (needle.length < MIN_QUERY) return [];
    const found: { entry: Entry; matchAt: number }[] = [];
    for (const entry of entries) {
      const index = entry.text.toLowerCase().indexOf(needle);
      if (index === -1) continue;
      found.push({ entry, matchAt: index });
    }
    return found.slice(0, MAX_RESULTS);
  }, [entries, needle]);

  return (
    <div className="space-y-4">
      <div className="relative">
        <Icon
          name="search"
          className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-ink-faint)]"
        />
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t.knowledge.search.placeholder}
          aria-label={t.knowledge.search.aria}
          className="min-h-[48px] w-full rounded-xl border border-[var(--color-edge-bright)] bg-[var(--color-field)] py-2 pl-10 pr-3 text-[var(--color-ink)] placeholder:text-[var(--color-ink-faint)] focus:border-[var(--color-signal)]/55 focus:outline-none focus:ring-2 focus:ring-[var(--color-signal)]/30"
        />
      </div>

      <p className="text-[0.72rem] text-[var(--color-ink-faint)]">{t.knowledge.search.hint(entries.length)}</p>

      {needle.length < MIN_QUERY ? (
        <EmptyState
          icon="search"
          title={t.knowledge.search.prompt.title}
          body={entries.length === 0 ? t.knowledge.search.prompt.nothing : t.knowledge.search.prompt.minChars(MIN_QUERY)}
        />
      ) : results.length === 0 ? (
        <EmptyState icon="search" title={t.knowledge.search.noResults.title} body={t.knowledge.search.noResults.body(query.trim())} />
      ) : (
        <ul className="space-y-2">
          {results.map(({ entry, matchAt }) => (
            <li key={entry.key}>
              <a
                href={href({ name: 'mission', id: entry.missionId })}
                className="panel block px-4 py-3 transition hover:border-[var(--color-edge-bright)] hover:bg-[var(--color-surface-2)]/60"
              >
                <span className="flex items-center gap-2">
                  <Badge tone={entry.kind === 'brief' ? 'ok' : 'signal'}>{entry.origin}</Badge>
                  <span className="truncate text-[0.86rem] font-medium text-[var(--color-ink)]">
                    {cleanPrompt(entry.missionTitle)}
                  </span>
                </span>
                <span className="mt-1.5 block text-[0.78rem] leading-relaxed text-[var(--color-ink-dim)]">
                  <Highlighted text={entry.text} at={matchAt} length={needle.length} />
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A short window of `text` around a match, with the match itself marked. */
function Highlighted({ text, at, length }: { text: string; at: number; length: number }) {
  const start = Math.max(0, at - 70);
  const end = Math.min(text.length, at + length + 110);
  const flat = (s: string) => s.replace(/[#*_`>|]/g, '').replace(/\s+/g, ' ');

  return (
    <Fragment>
      {start > 0 && '…'}
      {flat(text.slice(start, at))}
      <mark className="rounded bg-[var(--color-signal)]/25 px-0.5 text-[var(--color-ink)]">
        {flat(text.slice(at, at + length))}
      </mark>
      {flat(text.slice(at + length, end))}
      {end < text.length && '…'}
    </Fragment>
  );
}
