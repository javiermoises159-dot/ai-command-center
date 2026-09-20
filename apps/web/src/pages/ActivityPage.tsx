import { useMemo, useState } from 'react';

import { Icon, type IconName } from '../components/icons.tsx';
import { Button, EmptyState, ErrorBanner, LinkButton, ListSkeleton, PageHeader, Segmented } from '../components/primitives.tsx';
import { EngineActivity } from '../components/madre/EngineActivity.tsx';
import { useRecentMissions } from '../hooks/useRecentMissions.ts';
import { buildActivity, matchesGroup, type ActivityEvent, type ActivityGroup, type ActivityKind } from '../lib/activity.ts';
import { clockTime, cleanPrompt, cx, dayLabel, relativeTime } from '../lib/format.ts';
import { href } from '../lib/router.tsx';
import { t } from '../i18n/index.ts';

const PAGE_SIZE = 30;

interface KindStyle {
  label: string;
  icon: IconName;
  tone: string;
}

const KIND_STYLES: Record<ActivityKind, KindStyle> = {
  mission_created: {
    label: t.activity.kinds.mission_created,
    icon: 'plus',
    tone: 'bg-violet-600/10 text-violet-700 ring-violet-600/25 dark:bg-violet-400/10 dark:text-violet-300 dark:ring-violet-400/25',
  },
  run_started: {
    label: t.activity.kinds.run_started,
    icon: 'play',
    tone: 'bg-cyan-600/10 text-cyan-800 ring-cyan-700/25 dark:bg-cyan-400/10 dark:text-cyan-300 dark:ring-cyan-400/25',
  },
  agent_started: {
    label: t.activity.kinds.agent_started,
    icon: 'circle-dot',
    tone: 'bg-cyan-600/10 text-cyan-800 ring-cyan-700/25 dark:bg-cyan-400/10 dark:text-cyan-300 dark:ring-cyan-400/25',
  },
  agent_completed: {
    label: t.activity.kinds.agent_completed,
    icon: 'check',
    tone: 'bg-emerald-600/10 text-emerald-800 ring-emerald-700/25 dark:bg-emerald-400/10 dark:text-emerald-300 dark:ring-emerald-400/25',
  },
  agent_failed: {
    label: t.activity.kinds.agent_failed,
    icon: 'alert',
    tone: 'bg-rose-600/10 text-rose-800 ring-rose-700/25 dark:bg-rose-400/10 dark:text-rose-300 dark:ring-rose-400/25',
  },
  agent_skipped: {
    label: t.activity.kinds.agent_skipped,
    icon: 'skip',
    tone: 'bg-[var(--color-tint)] text-[var(--color-ink-faint)] ring-[var(--color-line)]',
  },
  run_completed: {
    label: t.activity.kinds.run_completed,
    icon: 'flag',
    tone: 'bg-emerald-600/10 text-emerald-800 ring-emerald-700/25 dark:bg-emerald-400/10 dark:text-emerald-300 dark:ring-emerald-400/25',
  },
  run_failed: {
    label: t.activity.kinds.run_failed,
    icon: 'alert',
    tone: 'bg-rose-600/10 text-rose-800 ring-rose-700/25 dark:bg-rose-400/10 dark:text-rose-300 dark:ring-rose-400/25',
  },
};

const GROUPS: readonly { value: ActivityGroup; label: string }[] = [
  { value: 'all', label: t.activity.groups.all },
  { value: 'runs', label: t.activity.groups.runs },
  { value: 'agents', label: t.activity.groups.agents },
  { value: 'failures', label: t.activity.groups.failures },
];

function MissionActivity() {
  const recent = useRecentMissions(15);
  const [group, setGroup] = useState<ActivityGroup>('all');
  const [limit, setLimit] = useState(PAGE_SIZE);

  const all = useMemo(() => buildActivity(recent.missions), [recent.missions]);
  const filtered = useMemo(() => all.filter((e) => matchesGroup(e.kind, group)), [all, group]);
  const shown = filtered.slice(0, limit);

  // Group the visible slice by calendar day, preserving newest-first order.
  const days = useMemo(() => {
    const out: { label: string; events: ActivityEvent[] }[] = [];
    for (const event of shown) {
      const label = dayLabel(event.at);
      const last = out[out.length - 1];
      if (last !== undefined && last.label === label) last.events.push(event);
      else out.push({ label, events: [event] });
    }
    return out;
  }, [shown]);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented
          label={t.activity.filterAria}
          value={group}
          onChange={(next) => {
            setGroup(next);
            setLimit(PAGE_SIZE);
          }}
          options={GROUPS}
        />
        {recent.live && (
          <span className="flex items-center gap-2 text-[0.74rem] font-medium text-[var(--color-signal)]">
            <span className="h-2 w-2 rounded-full bg-[var(--color-signal)] acc-pulse" aria-hidden />
            {t.activity.live}
          </span>
        )}
      </div>

      {recent.error !== null && recent.missions.length === 0 ? (
        <ErrorBanner message={recent.error} onRetry={recent.refresh} />
      ) : recent.loading && recent.missions.length === 0 ? (
        <ListSkeleton rows={5} />
      ) : all.length === 0 ? (
        <EmptyState
          icon="activity"
          title={t.activity.empty.title}
          body={t.activity.empty.body}
          action={
            <LinkButton href={href({ name: 'dashboard' })} variant="primary">
              {t.activity.empty.action}
            </LinkButton>
          }
        />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon="check"
          title={group === 'failures' ? t.activity.noMatch.failuresTitle : t.activity.noMatch.otherTitle}
          body={group === 'failures' ? t.activity.noMatch.failuresBody : t.activity.noMatch.otherBody}
        />
      ) : (
        <div className="space-y-6">
          {days.map((day) => (
            <section key={day.label}>
              <h2 className="mb-3 text-[0.7rem] font-semibold uppercase tracking-[0.18em] text-[var(--color-ink-faint)]">
                {day.label}
              </h2>
              <ol className="relative space-y-1 before:absolute before:bottom-3 before:left-[1.05rem] before:top-3 before:w-px before:bg-[var(--color-edge)]">
                {day.events.map((event) => (
                  <EventRow key={event.id} event={event} />
                ))}
              </ol>
            </section>
          ))}

          {filtered.length > shown.length && (
            <div className="flex justify-center">
              <Button variant="ghost" onClick={() => setLimit((n) => n + PAGE_SIZE)}>
                {t.activity.showMore(Math.min(PAGE_SIZE, filtered.length - shown.length))}
                <span className="tabular text-[var(--color-ink-faint)]">{t.activity.remaining(filtered.length - shown.length)}</span>
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function EventRow({ event }: { event: ActivityEvent }) {
  const style = KIND_STYLES[event.kind];
  const failed = event.kind === 'agent_failed' || event.kind === 'run_failed';

  return (
    <li className="relative">
      <a
        href={href({ name: 'mission', id: event.missionId })}
        className="group flex items-start gap-3 rounded-xl px-1.5 py-2 transition hover:bg-[var(--color-tint)]"
      >
        <span className={cx('relative z-10 grid h-8 w-8 shrink-0 place-items-center rounded-full ring-1', style.tone)}>
          <Icon name={style.icon} className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-[0.86rem] font-medium text-[var(--color-ink)]">{style.label}</span>
            {event.agentName !== null && (
              <span className="text-[0.86rem] text-[var(--color-ink-dim)]">· {event.agentName}</span>
            )}
            {event.runAttempt !== null && (
              <span className="tabular text-[0.7rem] text-[var(--color-ink-faint)]">{t.activity.runNumber(event.runAttempt)}</span>
            )}
          </span>
          <span className="block truncate text-[0.76rem] text-[var(--color-ink-faint)] group-hover:text-[var(--color-ink-dim)]">
            {cleanPrompt(event.missionTitle)}
          </span>
          {failed && event.detail !== null && (
            <span className="mt-1 block text-[0.76rem] text-[var(--color-bad)]">{event.detail}</span>
          )}
        </span>
        <time
          dateTime={event.at}
          title={relativeTime(event.at)}
          className="tabular shrink-0 pt-0.5 text-[0.7rem] text-[var(--color-ink-faint)]"
        >
          {clockTime(event.at)}
        </time>
      </a>
    </li>
  );
}

export function ActivityPage() {
  const [source, setSource] = useState<'missions' | 'engine'>('missions');
  return (
    <div className="space-y-5">
      <PageHeader
        icon="activity"
        title={t.activity.title}
        description={t.activity.description}
      />
      <Segmented
        label={t.activity.sourceAria}
        value={source}
        onChange={setSource}
        options={[
          { value: 'missions', label: t.activity.sources.missions },
          { value: 'engine', label: t.activity.sources.engine },
        ]}
      />
      <div key={source} className="acc-fade">
        {source === 'missions' ? <MissionActivity /> : <EngineActivity />}
      </div>
    </div>
  );
}
