import { useEffect, useState } from 'react';

import type { MadreMemoryEntry } from '@acc/contracts';

import { t } from '../../i18n/index.ts';
import { api, ApiClientError } from '../../lib/api.ts';
import { useMadreMemory } from '../../hooks/useMadre.ts';
import { relativeTime, cx } from '../../lib/format.ts';
import { titleCase } from '../../lib/madre.ts';
import { Icon } from '../icons.tsx';
import { Badge, Button, EmptyState, ErrorBanner, ListSkeleton, Panel, Stat } from '../primitives.tsx';

const USER_TYPES = ['user_context', 'project_context', 'preference', 'decision', 'fact'] as const;

const typeLabel = (type: string): string => t.knowledge.memory.types[type] ?? titleCase(type);

/**
 * MADRE's memory, as stored: every entry with where it came from and how far it
 * can be trusted. Things you add here are marked as coming from you and are not
 * counted as verified unless you give a reference.
 */
export function MemoryPanel() {
  const [draft, setDraft] = useState('');
  const [q, setQ] = useState('');
  const memory = useMadreMemory(q, '');

  useEffect(() => {
    const timer = setTimeout(() => setQ(draft.trim()), 300);
    return () => clearTimeout(timer);
  }, [draft]);

  const items = memory.data?.items ?? [];
  const stats = memory.data?.stats ?? null;
  const copy = t.knowledge.memory;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-2.5">
        <Stat label={copy.stats.entries} value={stats?.total ?? '—'} loading={stats === null && memory.error === null} />
        <Stat label={copy.stats.verified} value={stats?.verified ?? '—'} tone="ok" loading={stats === null && memory.error === null} />
        <Stat label={copy.stats.lessons} value={stats?.lessons ?? '—'} tone="signal" loading={stats === null && memory.error === null} />
      </div>

      <AddEntry onAdded={memory.refresh} />

      <div className="relative">
        <Icon name="search" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-ink-faint)]" />
        <input
          type="search"
          id="memory-search"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={copy.searchPlaceholder}
          aria-label={copy.searchAria}
          className="min-h-[44px] w-full rounded-xl border border-[var(--color-edge-bright)] bg-[var(--color-field)] py-2 pl-9 pr-3 text-[var(--color-ink)] placeholder:text-[var(--color-ink-faint)] focus:border-[var(--color-signal)]/55 focus:outline-none focus:ring-2 focus:ring-[var(--color-signal)]/30"
        />
      </div>

      {memory.error !== null && items.length === 0 ? (
        <ErrorBanner message={memory.error} onRetry={memory.refresh} />
      ) : memory.loading && items.length === 0 ? (
        <ListSkeleton rows={3} />
      ) : items.length === 0 ? (
        <EmptyState
          icon="database"
          title={q === '' ? copy.empty.titleEmpty : copy.empty.titleSearch}
          body={q === '' ? copy.empty.bodyEmpty : copy.empty.bodySearch(q)}
        />
      ) : (
        <ul className="space-y-2">
          {items.map((entry) => (
            <EntryCard key={entry.id} entry={entry} onForgotten={memory.refresh} />
          ))}
        </ul>
      )}
    </div>
  );
}

function AddEntry({ onAdded }: { onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [type, setType] = useState<(typeof USER_TYPES)[number]>('user_context');
  const [ref, setRef] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const copy = t.knowledge.memory.add;

  async function save() {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const result = await api.madreRemember({ title: title.trim(), content: content.trim(), type, ...(ref.trim() !== '' ? { ref: ref.trim() } : {}) });
      setTitle('');
      setContent('');
      setRef('');
      setNote(result.adjustments.length > 0 ? result.adjustments.join(' ') : copy.saved);
      onAdded();
    } catch (caught) {
      setError(caught instanceof ApiClientError ? (caught.issues[0]?.message ?? caught.message) : copy.saveFailed);
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <Button variant="ghost" onClick={() => setOpen(true)} className="w-full sm:w-auto">
        <Icon name="plus" className="h-4 w-4" />
        {copy.open}
      </Button>
    );
  }

  const field = 'w-full rounded-xl border border-[var(--color-edge-bright)] bg-[var(--color-field)] px-3 py-2.5 text-[0.86rem] text-[var(--color-ink)] placeholder:text-[var(--color-ink-faint)] focus:border-[var(--color-signal)]/55 focus:outline-none focus:ring-2 focus:ring-[var(--color-signal)]/30';
  return (
    <Panel className="space-y-3 p-4">
      <div>
        <label htmlFor="mem-title" className="mb-1 block text-[0.72rem] font-medium text-[var(--color-ink-dim)]">{copy.title}</label>
        <input id="mem-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={160} className={field} />
      </div>
      <div>
        <label htmlFor="mem-content" className="mb-1 block text-[0.72rem] font-medium text-[var(--color-ink-dim)]">{copy.content}</label>
        <textarea id="mem-content" value={content} onChange={(e) => setContent(e.target.value)} rows={3} maxLength={8000} className={cx(field, 'resize-y')} />
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="mem-type" className="mb-1 block text-[0.72rem] font-medium text-[var(--color-ink-dim)]">{copy.kind}</label>
          <select id="mem-type" value={type} onChange={(e) => setType(e.target.value as (typeof USER_TYPES)[number])} className={cx(field, 'min-h-[44px]')}>
            {USER_TYPES.map((kind) => (
              <option key={kind} value={kind}>{typeLabel(kind)}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="mem-ref" className="mb-1 block text-[0.72rem] font-medium text-[var(--color-ink-dim)]">{copy.source}</label>
          <input id="mem-ref" value={ref} onChange={(e) => setRef(e.target.value)} placeholder={copy.sourcePlaceholder} className={field} />
        </div>
      </div>
      {error !== null && <p role="alert" className="text-[0.78rem] text-[var(--color-bad)]">{error}</p>}
      {note !== null && <p className="text-[0.78rem] text-[var(--color-ink-dim)]">{note}</p>}
      <div className="flex gap-2">
        <Button onClick={() => void save()} busy={busy} disabled={title.trim() === '' || content.trim() === ''}>{copy.save}</Button>
        <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>{copy.close}</Button>
      </div>
    </Panel>
  );
}

function EntryCard({ entry, onForgotten }: { entry: MadreMemoryEntry; onForgotten: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const copy = t.knowledge.memory.entry;
  const origin = t.knowledge.memory.origins[entry.source.origin] ?? entry.source.origin;

  async function forget() {
    setBusy(true);
    setError(null);
    try {
      await api.madreForget(entry.id);
      onForgotten();
    } catch (caught) {
      setError(caught instanceof ApiClientError ? caught.message : copy.forgetFailed);
      setBusy(false);
    }
  }

  return (
    <li>
      <Panel as="article" className="p-4">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <h3 className="min-w-0 flex-1 text-[0.9rem] font-medium text-[var(--color-ink)]">{entry.title}</h3>
          <Badge tone={entry.verified ? 'ok' : 'neutral'}>{entry.verified ? copy.verified : copy.unverified}</Badge>
          <Badge>{typeLabel(entry.type)}</Badge>
        </div>
        <p className="mt-1.5 line-clamp-4 whitespace-pre-wrap text-[0.8rem] leading-relaxed text-[var(--color-ink-dim)]">{entry.content}</p>
        <p className="tabular mt-2 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[0.68rem] text-[var(--color-ink-faint)]">
          <span>{copy.from(origin, entry.source.ref)}</span>
          <span>{copy.confidence(Math.round(entry.confidence * 100))}</span>
          <span>{relativeTime(entry.createdAt)}</span>
          {entry.expiresAt !== null && <span>{copy.expires(relativeTime(entry.expiresAt))}</span>}
        </p>
        {error !== null && <p role="alert" className="mt-1 text-[0.74rem] text-[var(--color-bad)]">{error}</p>}
        <div className="mt-2">
          <button type="button" onClick={() => void forget()} disabled={busy} className="min-h-[44px] rounded-lg px-2 text-[0.74rem] font-medium text-[var(--color-ink-faint)] hover:text-[var(--color-bad)] disabled:opacity-60">
            {busy ? copy.forgetting : copy.forget}
          </button>
        </div>
      </Panel>
    </li>
  );
}
