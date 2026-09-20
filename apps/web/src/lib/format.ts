import type { AgentStatus, MissionStatus } from '@acc/contracts';

import { LOCALE, t } from '../i18n/index.ts';

/** One decimal, with the locale's decimal separator ("1,5" in Spanish). */
function oneDecimal(value: number): string {
  return value.toLocaleString(LOCALE, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

/** Compact relative time: "ahora mismo", "hace 4 min", "hace 3 días". */
export function relativeTime(iso: string | null): string {
  if (iso === null) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';

  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 45) return t.common.time.justNow;
  if (seconds < 3600) return t.common.time.minutesAgo(Math.round(seconds / 60));
  if (seconds < 86_400) return t.common.time.hoursAgo(Math.round(seconds / 3600));
  if (seconds < 604_800) return t.common.time.daysAgo(Math.round(seconds / 86_400));
  return new Date(iso).toLocaleDateString(LOCALE, { month: 'short', day: 'numeric' });
}

export function absoluteTime(iso: string | null): string {
  if (iso === null) return '—';
  return new Date(iso).toLocaleString(LOCALE, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Wall-clock time with seconds, for timeline rows where order within a minute matters. */
export function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** "Hoy", "Ayer" or a short date: the group heading in the activity timeline. */
export function dayLabel(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays = Math.round((startOf(now) - startOf(date)) / 86_400_000);
  if (diffDays === 0) return t.common.time.today;
  if (diffDays === 1) return t.common.time.yesterday;
  return date.toLocaleDateString(LOCALE, { weekday: 'short', month: 'short', day: 'numeric' });
}

/** Elapsed time with the unit spaced as Spanish writes it: "350 ms", "1,5 s", "2 min 5 s". */
export function duration(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${oneDecimal(ms / 1000)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes} min ${seconds} s`;
}

export function compactNumber(value: number): string {
  if (value < 1000) return value.toLocaleString(LOCALE);
  if (value < 1_000_000) return value < 10_000 ? `${oneDecimal(value / 1000)} k` : `${Math.round(value / 1000)} k`;
  return `${oneDecimal(value / 1_000_000)} M`;
}

/** Strip mock control directives from anything shown to the user. */
export function cleanPrompt(prompt: string): string {
  return prompt.replace(/\[[a-z]+:[^\]]*\]/gi, '').replace(/\s+/g, ' ').trim();
}

/** Directives present in a prompt, surfaced explicitly rather than hidden. */
export function extractDirectives(prompt: string): string[] {
  return [...prompt.matchAll(/\[[a-z]+:[^\]]*\]/gi)].map((m) => m[0]);
}

/**
 * A one-line plain-text preview of a Markdown result. Headings, quotes and
 * fences are skipped so the preview is the first line of actual prose.
 */
export function excerpt(markdown: string | null, max = 140): string {
  if (markdown === null) return '';
  for (const raw of markdown.split('\n')) {
    const line = raw.trim();
    if (line === '' || /^(#|>|```|---|\|)/.test(line)) continue;
    const plain = line
      .replace(/^[-*+]\s+|^\d+\.\s+/, '')
      .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, '$1$2')
      .replace(/[*_`]/g, '')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .trim();
    if (plain.length < 12) continue;
    return plain.length > max ? `${plain.slice(0, max - 1).trimEnd()}…` : plain;
  }
  return '';
}

// ---------------------------------------------------------------------------
// Status presentation
//
// Every tinted colour is written twice — a deep shade for the light theme and a
// bright one behind `dark:` — so status stays readable on both backgrounds.
// ---------------------------------------------------------------------------

export interface StatusStyle {
  label: string;
  dot: string;
  text: string;
  chip: string;
}

export const AGENT_STATUS_STYLES: Record<AgentStatus, StatusStyle> = {
  pending: {
    label: t.layout.status.pending,
    dot: 'bg-[var(--color-ink-faint)]',
    text: 'text-[var(--color-ink-faint)]',
    chip: 'bg-[var(--color-tint)] text-[var(--color-ink-dim)] ring-1 ring-[var(--color-line)]',
  },
  running: {
    label: t.layout.status.running,
    dot: 'bg-[var(--color-signal)] shadow-[0_0_10px_2px_var(--color-signal)]',
    text: 'text-[var(--color-signal)]',
    chip: 'bg-cyan-600/10 text-cyan-800 ring-1 ring-cyan-700/30 dark:bg-cyan-400/10 dark:text-cyan-300 dark:ring-cyan-400/30',
  },
  completed: {
    label: t.layout.status.completed,
    dot: 'bg-[var(--color-ok)]',
    text: 'text-[var(--color-ok)]',
    chip: 'bg-emerald-600/10 text-emerald-800 ring-1 ring-emerald-700/25 dark:bg-emerald-400/10 dark:text-emerald-300 dark:ring-emerald-400/25',
  },
  failed: {
    label: t.layout.status.failed,
    dot: 'bg-[var(--color-bad)]',
    text: 'text-[var(--color-bad)]',
    chip: 'bg-rose-600/10 text-rose-800 ring-1 ring-rose-700/25 dark:bg-rose-400/10 dark:text-rose-300 dark:ring-rose-400/25',
  },
  skipped: {
    label: t.layout.status.skipped,
    dot: 'bg-[var(--color-ink-faint)] opacity-50',
    text: 'text-[var(--color-ink-faint)]',
    chip: 'bg-[var(--color-tint)] text-[var(--color-ink-faint)] ring-1 ring-[var(--color-line)]',
  },
};

export const MISSION_STATUS_STYLES: Record<MissionStatus, StatusStyle> = {
  pending: AGENT_STATUS_STYLES.pending,
  running: AGENT_STATUS_STYLES.running,
  completed: AGENT_STATUS_STYLES.completed,
  failed: AGENT_STATUS_STYLES.failed,
};

/** Tailwind classes per agent accent token from the catalog. */
export const ACCENT_CLASSES: Record<string, string> = {
  violet: 'text-violet-700 bg-violet-600/10 ring-violet-600/25 dark:text-violet-300 dark:bg-violet-400/10 dark:ring-violet-400/25',
  sky: 'text-sky-700 bg-sky-600/10 ring-sky-600/25 dark:text-sky-300 dark:bg-sky-400/10 dark:ring-sky-400/25',
  emerald: 'text-emerald-700 bg-emerald-600/10 ring-emerald-600/25 dark:text-emerald-300 dark:bg-emerald-400/10 dark:ring-emerald-400/25',
  fuchsia: 'text-fuchsia-700 bg-fuchsia-600/10 ring-fuchsia-600/25 dark:text-fuchsia-300 dark:bg-fuchsia-400/10 dark:ring-fuchsia-400/25',
  amber: 'text-amber-700 bg-amber-600/10 ring-amber-600/25 dark:text-amber-300 dark:bg-amber-400/10 dark:ring-amber-400/25',
  lime: 'text-lime-800 bg-lime-600/10 ring-lime-700/25 dark:text-lime-300 dark:bg-lime-400/10 dark:ring-lime-400/25',
  rose: 'text-rose-700 bg-rose-600/10 ring-rose-600/25 dark:text-rose-300 dark:bg-rose-400/10 dark:ring-rose-400/25',
  cyan: 'text-cyan-800 bg-cyan-600/10 ring-cyan-700/25 dark:text-cyan-300 dark:bg-cyan-400/10 dark:ring-cyan-400/25',
};

export function accentClass(accent: string): string {
  return ACCENT_CLASSES[accent] ?? ACCENT_CLASSES['cyan'] ?? '';
}

export function cx(...values: (string | false | null | undefined)[]): string {
  return values.filter(Boolean).join(' ');
}
