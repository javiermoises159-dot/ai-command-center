import type { ReactNode } from 'react';

import { t } from '../i18n/index.ts';
import { AGENT_STATUS_STYLES, MISSION_STATUS_STYLES, accentClass, cx } from '../lib/format.ts';
import type { AgentStatus, MissionStatus } from '../lib/api.ts';
import { Icon, type IconName } from './icons.tsx';

export function StatusDot({ status, size = 'md' }: { status: AgentStatus; size?: 'sm' | 'md' }) {
  // Defensive: a status added to the API before this bundle is redeployed must
  // render as something neutral rather than crashing the pipeline view.
  const style = AGENT_STATUS_STYLES[status] ?? AGENT_STATUS_STYLES.pending;
  return (
    <span
      className={cx(
        'inline-block shrink-0 rounded-full',
        size === 'sm' ? 'h-1.5 w-1.5' : 'h-2.5 w-2.5',
        style.dot,
        status === 'running' && 'acc-pulse',
      )}
      aria-hidden
    />
  );
}

export function StatusChip({ status, kind = 'agent' }: { status: string; kind?: 'agent' | 'mission' }) {
  const style =
    kind === 'mission'
      ? MISSION_STATUS_STYLES[status as MissionStatus]
      : AGENT_STATUS_STYLES[status as AgentStatus];
  if (!style) return null;

  return (
    <span
      className={cx(
        'inline-flex max-w-full shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[0.68rem] font-medium uppercase tracking-wider',
        style.chip,
      )}
    >
      <span className={cx('h-1.5 w-1.5 rounded-full', style.dot, status === 'running' && 'acc-pulse')} />
      {style.label}
    </span>
  );
}

export function Panel({
  children,
  className,
  as: Tag = 'div',
}: {
  children: ReactNode;
  className?: string;
  as?: 'div' | 'section' | 'article';
}) {
  return <Tag className={cx('panel', className)}>{children}</Tag>;
}

export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-3 flex items-baseline justify-between gap-3">
      <h2 className="text-[0.7rem] font-semibold uppercase tracking-[0.18em] text-[var(--color-ink-faint)]">
        {children}
      </h2>
      {action}
    </div>
  );
}

/** Title block at the top of every section screen. */
export function PageHeader({
  icon,
  title,
  description,
  actions,
}: {
  icon: IconName;
  title: string;
  description: string;
  actions?: ReactNode;
}) {
  return (
    <header className="mb-6 flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
      <div className="flex min-w-0 items-start gap-3.5">
        <span className="mt-0.5 grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-[var(--color-signal)]/12 text-[var(--color-signal)] ring-1 ring-[var(--color-signal)]/25">
          <Icon name={icon} className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight text-[var(--color-ink)] sm:text-2xl">{title}</h1>
          <p className="mt-1 max-w-2xl text-[0.85rem] leading-relaxed text-[var(--color-ink-dim)]">{description}</p>
        </div>
      </div>
      {actions !== undefined && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  );
}

export function Stat({
  label,
  value,
  tone = 'neutral',
  loading = false,
}: {
  label: string;
  value: number | string;
  tone?: 'neutral' | 'signal' | 'ok' | 'bad';
  loading?: boolean;
}) {
  const toneClass = {
    neutral: 'text-[var(--color-ink)]',
    signal: 'text-[var(--color-signal)]',
    ok: 'text-[var(--color-ok)]',
    bad: 'text-[var(--color-bad)]',
  }[tone];

  return (
    <div className="panel px-3.5 py-3">
      {loading ? (
        <Skeleton className="h-6 w-10" />
      ) : (
        <div className={cx('tabular text-2xl font-semibold leading-none', toneClass)}>{value}</div>
      )}
      <div className="mt-2 text-[0.64rem] uppercase tracking-[0.14em] text-[var(--color-ink-faint)]">{label}</div>
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <svg className={cx('h-4 w-4 animate-spin', className)} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.2" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

/** Loading placeholder with a moving highlight. Size it with `className`. */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cx('acc-skeleton rounded-md', className)} aria-hidden />;
}

/** A stack of card-shaped skeletons, used while a list loads. */
export function ListSkeleton({ rows = 3, className }: { rows?: number; className?: string }) {
  return (
    <div className={cx('space-y-2', className)} role="status" aria-label={t.common.states.loading}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="panel space-y-3 px-3.5 py-3.5">
          <div className="flex items-center justify-between gap-4">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-5 w-16 rounded-full" />
          </div>
          <Skeleton className="h-1 w-full" />
          <Skeleton className="h-3 w-1/3" />
        </div>
      ))}
    </div>
  );
}

export function ErrorBanner({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-3 rounded-xl border border-rose-500/30 bg-rose-500/8 px-3.5 py-3 text-sm text-rose-800 dark:border-rose-400/25 dark:text-rose-200"
    >
      <Icon name="alert" className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="flex-1">
        <p>{message}</p>
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="mt-2 rounded-md bg-rose-500/15 px-2.5 py-1 text-xs font-medium hover:bg-rose-500/25"
          >
            {t.common.actions.retry}
          </button>
        )}
      </div>
    </div>
  );
}

export function EmptyState({
  title,
  body,
  action,
  icon = 'circle-dot',
}: {
  title: string;
  body: string;
  action?: ReactNode;
  icon?: IconName;
}) {
  return (
    <div className="panel flex flex-col items-center gap-2 px-6 py-10 text-center">
      <span className="grid h-11 w-11 place-items-center rounded-full bg-[var(--color-tint)] text-[var(--color-ink-faint)]">
        <Icon name={icon} className="h-5 w-5" />
      </span>
      <h3 className="mt-1 text-sm font-medium text-[var(--color-ink)]">{title}</h3>
      <p className="max-w-sm text-[0.82rem] leading-relaxed text-[var(--color-ink-faint)]">{body}</p>
      {action !== undefined && <div className="mt-2">{action}</div>}
    </div>
  );
}

/**
 * A banner that says plainly what is real and what is not on a screen. Used on
 * every section that shows placeholder or preview content, so nothing simulated
 * can be mistaken for a working integration.
 */
export function Notice({
  tone = 'mock',
  title,
  children,
}: {
  tone?: 'mock' | 'preview' | 'live';
  title: string;
  children: ReactNode;
}) {
  const style = {
    mock: 'border-amber-500/35 bg-amber-500/8 text-amber-900 dark:border-amber-400/25 dark:text-amber-200',
    preview: 'border-violet-500/30 bg-violet-500/8 text-violet-900 dark:border-violet-400/25 dark:text-violet-200',
    live: 'border-emerald-500/30 bg-emerald-500/8 text-emerald-900 dark:border-emerald-400/25 dark:text-emerald-200',
  }[tone];
  const icon: IconName = tone === 'live' ? 'check' : tone === 'preview' ? 'sparkles' : 'alert';

  return (
    <div className={cx('flex items-start gap-3 rounded-xl border px-3.5 py-3 text-[0.82rem] leading-relaxed', style)}>
      <Icon name={icon} className="mt-0.5 h-4 w-4 shrink-0" />
      <div>
        <p className="font-semibold">{title}</p>
        <p className="mt-0.5 opacity-90">{children}</p>
      </div>
    </div>
  );
}

/** Small label: "Mock", "Not connected", "Available"… Colour carries the meaning. */
export function Badge({
  tone = 'neutral',
  children,
  className,
}: {
  tone?: 'neutral' | 'ok' | 'warn' | 'bad' | 'signal';
  children: ReactNode;
  className?: string;
}) {
  const style = {
    neutral: 'bg-[var(--color-tint)] text-[var(--color-ink-dim)] ring-[var(--color-line)]',
    ok: 'bg-emerald-600/10 text-emerald-800 ring-emerald-700/25 dark:bg-emerald-400/10 dark:text-emerald-300 dark:ring-emerald-400/25',
    warn: 'bg-amber-600/10 text-amber-800 ring-amber-700/25 dark:bg-amber-400/10 dark:text-amber-300 dark:ring-amber-400/25',
    bad: 'bg-rose-600/10 text-rose-800 ring-rose-700/25 dark:bg-rose-400/10 dark:text-rose-300 dark:ring-rose-400/25',
    signal: 'bg-cyan-600/10 text-cyan-800 ring-cyan-700/25 dark:bg-cyan-400/10 dark:text-cyan-300 dark:ring-cyan-400/25',
  }[tone];

  return (
    <span
      className={cx(
        // max-w-full lets a long label (Spanish runs longer than English) wrap
        // inside its column instead of pushing the page sideways on a phone.
        'inline-flex max-w-full shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[0.62rem] font-semibold uppercase tracking-wider ring-1',
        style,
        className,
      )}
    >
      {children}
    </span>
  );
}

/** Rounded square holding an icon, tinted with an agent/accent colour. */
export function IconTile({
  icon,
  accent = 'cyan',
  size = 'md',
}: {
  icon: IconName;
  accent?: string;
  size?: 'sm' | 'md' | 'lg';
}) {
  const box = { sm: 'h-8 w-8 rounded-lg', md: 'h-10 w-10 rounded-xl', lg: 'h-12 w-12 rounded-xl' }[size];
  const glyph = { sm: 'h-4 w-4', md: 'h-5 w-5', lg: 'h-6 w-6' }[size];
  return (
    <span className={cx('grid shrink-0 place-items-center ring-1', box, accentClass(accent))}>
      <Icon name={icon} className={glyph} />
    </span>
  );
}

export function ProgressBar({ value, tone = 'signal' }: { value: number; tone?: 'signal' | 'ok' | 'bad' }) {
  const toneClass = {
    signal: 'bg-[var(--color-signal)]',
    ok: 'bg-[var(--color-ok)]',
    bad: 'bg-[var(--color-bad)]',
  }[tone];

  return (
    <div
      className="h-1 w-full overflow-hidden rounded-full bg-[var(--color-tint-strong)]"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(Math.min(1, Math.max(0, value)) * 100)}
    >
      <div
        className={cx('h-full rounded-full transition-[width] duration-500 ease-out', toneClass)}
        style={{ width: `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%` }}
      />
    </div>
  );
}

/** A row of mutually exclusive options (filters, tabs). */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
}: {
  value: T;
  onChange: (next: T) => void;
  options: readonly { value: T; label: string; count?: number }[];
  label: string;
}) {
  return (
    <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0" role="tablist" aria-label={label}>
      <div className="flex w-max gap-1.5 sm:w-auto sm:flex-wrap">
        {options.map((option) => {
          const active = option.value === value;
          return (
            <button
              key={option.value}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => onChange(option.value)}
              className={cx(
                'inline-flex shrink-0 items-center gap-1.5 rounded-full px-3.5 py-2 text-[0.78rem] transition',
                active
                  ? 'bg-[var(--color-signal)]/15 text-[var(--color-signal)] ring-1 ring-[var(--color-signal)]/40'
                  : 'bg-[var(--color-tint)] text-[var(--color-ink-dim)] ring-1 ring-[var(--color-line)] hover:bg-[var(--color-tint-strong)]',
              )}
            >
              {option.label}
              {option.count !== undefined && (
                <span className="tabular text-[0.68rem] opacity-70">{option.count}</span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

const BUTTON_VARIANTS = {
  primary:
    'bg-[var(--color-signal)] text-[var(--color-on-signal)] font-semibold hover:brightness-110 disabled:brightness-100',
  ghost:
    'bg-[var(--color-tint)] text-[var(--color-ink-dim)] ring-1 ring-[var(--color-line)] hover:bg-[var(--color-tint-strong)] hover:text-[var(--color-ink)]',
  danger: 'bg-rose-500/15 text-rose-700 ring-1 ring-rose-500/30 hover:bg-rose-500/25 dark:text-rose-200',
} as const;

// 44px min touch target: the iOS guideline, and the reason this is comfortable
// to use one-handed.
const BUTTON_BASE =
  'inline-flex min-h-[44px] items-center justify-center gap-2 rounded-xl px-4 text-sm transition active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60';

export function Button({
  children,
  onClick,
  type = 'button',
  variant = 'primary',
  disabled,
  className,
  busy,
}: {
  children: ReactNode;
  onClick?: () => void;
  type?: 'button' | 'submit';
  variant?: 'primary' | 'ghost' | 'danger';
  disabled?: boolean;
  className?: string;
  busy?: boolean;
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled === true || busy === true}
      className={cx(BUTTON_BASE, BUTTON_VARIANTS[variant], className)}
    >
      {busy === true && <Spinner />}
      {children}
    </button>
  );
}

/** A real navigation link that looks like a button. */
export function LinkButton({
  children,
  href,
  variant = 'ghost',
  className,
}: {
  children: ReactNode;
  href: string;
  variant?: 'primary' | 'ghost';
  className?: string;
}) {
  return (
    <a href={href} className={cx(BUTTON_BASE, BUTTON_VARIANTS[variant], className)}>
      {children}
    </a>
  );
}
