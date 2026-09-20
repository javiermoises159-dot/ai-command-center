import { useState } from 'react';

import type { MadreAuditEvent } from '@acc/contracts';

import { useMadreActivity } from '../../hooks/useMadre.ts';
import { clockTime, dayLabel, relativeTime } from '../../lib/format.ts';
import { href } from '../../lib/router.tsx';
import { Badge, Button, EmptyState, ErrorBanner, ListSkeleton } from '../primitives.tsx';
import { t } from '../../i18n/index.ts';

const PAGE = 60;
const ACTOR_TONE: Record<string, 'neutral' | 'ok' | 'warn' | 'bad' | 'signal'> = {
  user: 'signal',
  judge: 'warn',
  policy: 'warn',
  engine: 'neutral',
  router: 'neutral',
  compiler: 'neutral',
  memory: 'ok',
  cost: 'neutral',
  tool: 'neutral',
  madre: 'neutral',
};

/** The audit trail: every decision the engine recorded, newest first. */
export function EngineActivity() {
  const [limit, setLimit] = useState(PAGE);
  const events = useMadreActivity(limit);

  if (events.data === null) return events.error !== null ? <ErrorBanner message={events.error} onRetry={events.refresh} /> : <ListSkeleton rows={5} />;
  const items = events.data.items;
  if (items.length === 0) {
    return <EmptyState icon="activity" title={t.activity.engine.empty.title} body={t.activity.engine.empty.body} />;
  }

  const days: { label: string; events: MadreAuditEvent[] }[] = [];
  for (const event of items) {
    const label = dayLabel(event.at);
    const last = days[days.length - 1];
    if (last !== undefined && last.label === label) last.events.push(event);
    else days.push({ label, events: [event] });
  }

  return (
    <div className="space-y-6">
      {days.map((day) => (
        <section key={day.label}>
          <h2 className="mb-3 text-[0.7rem] font-semibold uppercase tracking-[0.18em] text-[var(--color-ink-faint)]">{day.label}</h2>
          <ol className="space-y-1">
            {day.events.map((event) => {
              const body = (
                <>
                  <time dateTime={event.at} title={relativeTime(event.at)} className="tabular w-14 shrink-0 pt-0.5 text-[0.7rem] text-[var(--color-ink-faint)]">
                    {clockTime(event.at)}
                  </time>
                  <Badge tone={ACTOR_TONE[event.actor] ?? 'neutral'} className="w-[4.5rem] justify-center">
                    {t.activity.engine.actors[event.actor] ?? event.actor}
                  </Badge>
                  <span className="min-w-0 flex-1 text-[0.8rem] leading-relaxed text-[var(--color-ink-dim)]">{event.message}</span>
                </>
              );
              return (
                <li key={event.id}>
                  {event.missionId !== null ? (
                    <a href={href({ name: 'mission', id: event.missionId })} className="flex items-start gap-2.5 rounded-xl px-1.5 py-2 hover:bg-[var(--color-tint)]">
                      {body}
                    </a>
                  ) : (
                    <div className="flex items-start gap-2.5 px-1.5 py-2">{body}</div>
                  )}
                </li>
              );
            })}
          </ol>
        </section>
      ))}
      {items.length >= limit && (
        <div className="flex justify-center">
          <Button variant="ghost" onClick={() => setLimit((n) => n + PAGE)}>
            {t.activity.engine.showMore}
          </Button>
        </div>
      )}
    </div>
  );
}
