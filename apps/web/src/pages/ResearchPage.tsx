import { useState } from 'react';

import { Icon } from '../components/icons.tsx';
import { Badge, EmptyState, Notice, PageHeader, Panel, Segmented } from '../components/primitives.tsx';
import { cx } from '../lib/format.ts';

/**
 * Everything on this screen is MOCK DATA. The Research Engine does not exist:
 * no search runs, no source is fetched, no citation is verified. The dataset is
 * shaped like the future engine's output so the layout can be designed against
 * it, and every source lives on an `example.*` domain so it cannot be mistaken
 * for a real reference.
 */

interface MockSource {
  id: string;
  name: string;
  url: string;
  kind: 'Article' | 'Report' | 'Dataset' | 'Registry';
}

interface MockResult {
  title: string;
  snippet: string;
  sourceId: string;
}

interface MockCitation {
  quote: string;
  sourceId: string;
  note: string;
}

interface MockSearch {
  id: string;
  query: string;
  ago: string;
  summary: string;
  results: MockResult[];
  sources: MockSource[];
  citations: MockCitation[];
}

const SEARCHES: readonly MockSearch[] = [
  {
    id: 's1',
    query: 'Online bakery market in Italy',
    ago: '2 hours ago',
    summary: 'Sample summary: demand signals, typical price bands and the main competing formats.',
    sources: [
      { id: 'a', name: 'Sample market overview', url: 'https://reports.example.com/bakery-overview', kind: 'Report' },
      { id: 'b', name: 'Sample retail trends article', url: 'https://news.example.org/retail-trends', kind: 'Article' },
      { id: 'c', name: 'Sample business registry', url: 'https://registry.example.net/food-businesses', kind: 'Registry' },
    ],
    results: [
      { title: 'Sample: category size and growth', snippet: 'A placeholder passage describing how a category might be sized, with the assumptions listed separately.', sourceId: 'a' },
      { title: 'Sample: who sells online today', snippet: 'A placeholder passage comparing three comparable sellers by angle rather than by revenue.', sourceId: 'b' },
      { title: 'Sample: registrations by region', snippet: 'A placeholder passage about the number of registered food businesses per region.', sourceId: 'c' },
    ],
    citations: [
      { quote: 'Placeholder quotation about category growth.', sourceId: 'a', note: 'Sample citation — not a real quotation.' },
      { quote: 'Placeholder quotation about online competitors.', sourceId: 'b', note: 'Sample citation — not a real quotation.' },
    ],
  },
  {
    id: 's2',
    query: 'Food labelling and e-commerce rules (EU)',
    ago: 'Yesterday',
    summary: 'Sample summary: the kinds of labelling and distance-selling obligations a food seller would check.',
    sources: [
      { id: 'a', name: 'Sample regulation guide', url: 'https://guides.example.org/food-labelling', kind: 'Article' },
      { id: 'b', name: 'Sample compliance checklist', url: 'https://compliance.example.com/checklist', kind: 'Dataset' },
    ],
    results: [
      { title: 'Sample: mandatory label fields', snippet: 'A placeholder list of the fields a food label typically has to carry.', sourceId: 'a' },
      { title: 'Sample: distance-selling basics', snippet: 'A placeholder passage on information a seller must give before purchase.', sourceId: 'b' },
    ],
    citations: [
      { quote: 'Placeholder quotation about label content.', sourceId: 'a', note: 'Sample citation — not a real quotation.' },
    ],
  },
  {
    id: 's3',
    query: 'Shipping perishable goods within Italy',
    ago: '3 days ago',
    summary: 'Sample summary: carrier options and packaging considerations for short-shelf-life products.',
    sources: [
      { id: 'a', name: 'Sample carrier comparison', url: 'https://logistics.example.com/carriers', kind: 'Report' },
      { id: 'b', name: 'Sample packaging study', url: 'https://packaging.example.net/study', kind: 'Report' },
    ],
    results: [
      { title: 'Sample: carrier lead times', snippet: 'A placeholder table comparing delivery windows across three carriers.', sourceId: 'a' },
      { title: 'Sample: protective packaging', snippet: 'A placeholder passage on packaging that limits breakage in transit.', sourceId: 'b' },
    ],
    citations: [
      { quote: 'Placeholder quotation about delivery windows.', sourceId: 'a', note: 'Sample citation — not a real quotation.' },
      { quote: 'Placeholder quotation about packaging.', sourceId: 'b', note: 'Sample citation — not a real quotation.' },
    ],
  },
];

type Pane = 'results' | 'sources' | 'citations';

export function ResearchPage() {
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string>(SEARCHES[0]?.id ?? '');
  const [pane, setPane] = useState<Pane>('results');

  const needle = query.trim().toLowerCase();
  const visible = SEARCHES.filter((s) => s.query.toLowerCase().includes(needle));
  const selected = SEARCHES.find((s) => s.id === selectedId) ?? visible[0];

  return (
    <div className="space-y-5">
      <PageHeader
        icon="search"
        title="Research"
        description="The future research engine: every finding backed by a named source and a citation you can check. This screen shows the shape it will take."
      />

      <Notice tone="mock" title="Mock data — the Research Engine is not built">
        Nothing on this screen was searched or fetched. The searches, sources and citations below are placeholders on
        example domains, here to design the layout against.
      </Notice>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[18rem_minmax(0,1fr)]">
        {/* --------------------------------------------------- Recent searches */}
        <section aria-label="Recent searches" className="space-y-3">
          <div className="relative">
            <Icon
              name="search"
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-ink-faint)]"
            />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter recent searches"
              aria-label="Filter recent searches"
              className="min-h-[44px] w-full rounded-xl border border-[var(--color-edge-bright)] bg-[var(--color-field)] py-2 pl-9 pr-3 text-[var(--color-ink)] placeholder:text-[var(--color-ink-faint)] focus:border-[var(--color-signal)]/55 focus:outline-none focus:ring-2 focus:ring-[var(--color-signal)]/30"
            />
          </div>

          <h2 className="text-[0.7rem] font-semibold uppercase tracking-[0.18em] text-[var(--color-ink-faint)]">
            Recent searches
          </h2>

          {visible.length === 0 ? (
            <p className="rounded-xl bg-[var(--color-tint)] px-3 py-3 text-[0.8rem] text-[var(--color-ink-faint)]">
              No recent search matches “{query.trim()}”.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {visible.map((search) => {
                const active = search.id === selected?.id;
                return (
                  <li key={search.id}>
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedId(search.id);
                        setPane('results');
                      }}
                      aria-pressed={active}
                      className={cx(
                        'w-full rounded-xl px-3.5 py-3 text-left transition',
                        active
                          ? 'bg-[var(--color-signal)]/12 ring-1 ring-[var(--color-signal)]/40'
                          : 'panel hover:bg-[var(--color-tint)]',
                      )}
                    >
                      <span className="block text-[0.86rem] font-medium leading-snug text-[var(--color-ink)]">{search.query}</span>
                      <span className="tabular mt-1 flex items-center gap-2 text-[0.7rem] text-[var(--color-ink-faint)]">
                        {search.ago} · {search.results.length} results · {search.sources.length} sources
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* ------------------------------------------------------------ Detail */}
        <section aria-label="Search details" className="min-w-0">
          {selected === undefined ? (
            <EmptyState icon="search" title="Select a search" body="Pick a recent search to see its results, sources and citations." />
          ) : (
            <div className="space-y-4">
              <Panel className="p-4">
                <div className="flex items-start justify-between gap-3">
                  <h2 className="text-base font-semibold text-[var(--color-ink)]">{selected.query}</h2>
                  <Badge tone="warn">Mock</Badge>
                </div>
                <p className="mt-1.5 text-[0.82rem] leading-relaxed text-[var(--color-ink-dim)]">{selected.summary}</p>
              </Panel>

              <Segmented
                label="Search detail"
                value={pane}
                onChange={setPane}
                options={[
                  { value: 'results', label: 'Results', count: selected.results.length },
                  { value: 'sources', label: 'Sources', count: selected.sources.length },
                  { value: 'citations', label: 'Citations', count: selected.citations.length },
                ]}
              />

              <div key={`${selected.id}-${pane}`} className="acc-fade space-y-2">
                {pane === 'results' &&
                  selected.results.map((result) => {
                    const source = selected.sources.find((s) => s.id === result.sourceId);
                    return (
                      <Panel key={result.title} as="article" className="px-4 py-3">
                        <h3 className="text-[0.9rem] font-medium text-[var(--color-ink)]">{result.title}</h3>
                        <p className="mt-1 text-[0.8rem] leading-relaxed text-[var(--color-ink-dim)]">{result.snippet}</p>
                        {source !== undefined && (
                          <p className="mt-2 flex items-center gap-1.5 text-[0.7rem] text-[var(--color-ink-faint)]">
                            <Icon name="link" className="h-3 w-3" />
                            {source.name}
                          </p>
                        )}
                      </Panel>
                    );
                  })}

                {pane === 'sources' &&
                  selected.sources.map((source) => (
                    <Panel key={source.id} as="article" className="flex items-start gap-3 px-4 py-3">
                      <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[var(--color-tint)] text-[var(--color-ink-faint)] ring-1 ring-[var(--color-line)]">
                        <Icon name="globe" className="h-4 w-4" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <h3 className="truncate text-[0.88rem] font-medium text-[var(--color-ink)]">{source.name}</h3>
                          <Badge>{source.kind}</Badge>
                        </div>
                        {/* Plain text on purpose: these URLs are not real and must not be clickable. */}
                        <p className="mt-0.5 break-all font-mono text-[0.72rem] text-[var(--color-ink-faint)]">{source.url}</p>
                      </div>
                    </Panel>
                  ))}

                {pane === 'citations' &&
                  selected.citations.map((citation) => {
                    const source = selected.sources.find((s) => s.id === citation.sourceId);
                    return (
                      <Panel key={citation.quote} as="article" className="px-4 py-3">
                        <div className="flex gap-3">
                          <Icon name="quote" className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-signal)]" />
                          <div className="min-w-0">
                            <p className="text-[0.86rem] italic leading-relaxed text-[var(--color-ink)]">{citation.quote}</p>
                            <p className="mt-1.5 text-[0.72rem] text-[var(--color-ink-faint)]">
                              {source?.name ?? 'Unknown source'} · {citation.note}
                            </p>
                          </div>
                        </div>
                      </Panel>
                    );
                  })}
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
