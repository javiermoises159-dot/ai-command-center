import type { AgentStatus, MissionStatus } from '@acc/contracts';

/** Compact relative time: "just now", "4m ago", "3d ago". */
export function relativeTime(iso: string | null): string {
  if (iso === null) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';

  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 45) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  if (seconds < 604_800) return `${Math.round(seconds / 86_400)}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function absoluteTime(iso: string | null): string {
  if (iso === null) return '—';
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function duration(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

export function compactNumber(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

/** Strip mock control directives from anything shown to the user. */
export function cleanPrompt(prompt: string): string {
  return prompt.replace(/\[[a-z]+:[^\]]*\]/gi, '').replace(/\s+/g, ' ').trim();
}

/** Directives present in a prompt, surfaced explicitly rather than hidden. */
export function extractDirectives(prompt: string): string[] {
  return [...prompt.matchAll(/\[[a-z]+:[^\]]*\]/gi)].map((m) => m[0]);
}

// ---------------------------------------------------------------------------
// Status presentation
// ---------------------------------------------------------------------------

export interface StatusStyle {
  label: string;
  dot: string;
  text: string;
  chip: string;
}

export const AGENT_STATUS_STYLES: Record<AgentStatus, StatusStyle> = {
  pending: {
    label: 'Queued',
    dot: 'bg-[var(--color-ink-faint)]',
    text: 'text-[var(--color-ink-faint)]',
    chip: 'bg-white/5 text-[var(--color-ink-dim)] ring-1 ring-white/10',
  },
  running: {
    label: 'Working',
    dot: 'bg-[var(--color-signal)] shadow-[0_0_10px_2px_var(--color-signal)]',
    text: 'text-[var(--color-signal)]',
    chip: 'bg-cyan-400/10 text-cyan-300 ring-1 ring-cyan-400/30',
  },
  completed: {
    label: 'Done',
    dot: 'bg-[var(--color-ok)]',
    text: 'text-[var(--color-ok)]',
    chip: 'bg-emerald-400/10 text-emerald-300 ring-1 ring-emerald-400/25',
  },
  failed: {
    label: 'Failed',
    dot: 'bg-[var(--color-bad)]',
    text: 'text-[var(--color-bad)]',
    chip: 'bg-rose-400/10 text-rose-300 ring-1 ring-rose-400/25',
  },
  skipped: {
    label: 'Skipped',
    dot: 'bg-[var(--color-ink-faint)] opacity-50',
    text: 'text-[var(--color-ink-faint)]',
    chip: 'bg-white/5 text-[var(--color-ink-faint)] ring-1 ring-white/10',
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
  violet: 'text-violet-300 bg-violet-400/10 ring-violet-400/25',
  sky: 'text-sky-300 bg-sky-400/10 ring-sky-400/25',
  emerald: 'text-emerald-300 bg-emerald-400/10 ring-emerald-400/25',
  fuchsia: 'text-fuchsia-300 bg-fuchsia-400/10 ring-fuchsia-400/25',
  amber: 'text-amber-300 bg-amber-400/10 ring-amber-400/25',
  lime: 'text-lime-300 bg-lime-400/10 ring-lime-400/25',
  rose: 'text-rose-300 bg-rose-400/10 ring-rose-400/25',
  cyan: 'text-cyan-300 bg-cyan-400/10 ring-cyan-400/25',
};

export function accentClass(accent: string): string {
  return ACCENT_CLASSES[accent] ?? ACCENT_CLASSES['cyan'] ?? '';
}

export function cx(...values: (string | false | null | undefined)[]): string {
  return values.filter(Boolean).join(' ');
}
