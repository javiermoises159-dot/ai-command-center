import type { ReactNode } from 'react';

import { AGENT_STATUS_STYLES, MISSION_STATUS_STYLES, cx } from '../lib/format.ts';
import type { AgentStatus, MissionStatus } from '../lib/api.ts';

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
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[0.68rem] font-medium uppercase tracking-wider',
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

export function Stat({
  label,
  value,
  tone = 'neutral',
}: {
  label: string;
  value: number | string;
  tone?: 'neutral' | 'signal' | 'ok' | 'bad';
}) {
  const toneClass = {
    neutral: 'text-[var(--color-ink)]',
    signal: 'text-[var(--color-signal)]',
    ok: 'text-[var(--color-ok)]',
    bad: 'text-[var(--color-bad)]',
  }[tone];

  return (
    <div className="panel px-3 py-2.5">
      <div className={cx('tabular text-xl font-semibold leading-none', toneClass)}>{value}</div>
      <div className="mt-1.5 text-[0.62rem] uppercase tracking-[0.14em] text-[var(--color-ink-faint)]">{label}</div>
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

export function ErrorBanner({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-rose-400/25 bg-rose-500/8 px-3.5 py-3 text-sm text-rose-200">
      <span className="mt-0.5 text-base leading-none" aria-hidden>
        ⚠
      </span>
      <div className="flex-1">
        <p>{message}</p>
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="mt-2 rounded-md bg-rose-400/15 px-2.5 py-1 text-xs font-medium hover:bg-rose-400/25"
          >
            Try again
          </button>
        )}
      </div>
    </div>
  );
}

export function EmptyState({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return (
    <div className="panel flex flex-col items-center gap-2 px-6 py-10 text-center">
      <div className="text-2xl opacity-40" aria-hidden>
        ◎
      </div>
      <h3 className="text-sm font-medium text-[var(--color-ink)]">{title}</h3>
      <p className="max-w-xs text-[0.82rem] text-[var(--color-ink-faint)]">{body}</p>
      {action}
    </div>
  );
}

export function ProgressBar({ value, tone = 'signal' }: { value: number; tone?: 'signal' | 'ok' | 'bad' }) {
  const toneClass = {
    signal: 'bg-[var(--color-signal)]',
    ok: 'bg-[var(--color-ok)]',
    bad: 'bg-[var(--color-bad)]',
  }[tone];

  return (
    <div className="h-1 w-full overflow-hidden rounded-full bg-white/8">
      <div
        className={cx('h-full rounded-full transition-[width] duration-500 ease-out', toneClass)}
        style={{ width: `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%` }}
      />
    </div>
  );
}

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
  const variantClass = {
    primary:
      'bg-[var(--color-signal)] text-[#04212b] font-semibold hover:bg-cyan-300 disabled:bg-[var(--color-signal)]/40',
    ghost:
      'bg-white/5 text-[var(--color-ink-dim)] ring-1 ring-white/10 hover:bg-white/10 hover:text-[var(--color-ink)]',
    danger: 'bg-rose-500/15 text-rose-200 ring-1 ring-rose-400/30 hover:bg-rose-500/25',
  }[variant];

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled === true || busy === true}
      className={cx(
        // 44px min touch target — the iOS guideline, and the reason this is
        // comfortable to use one-handed.
        'inline-flex min-h-[44px] items-center justify-center gap-2 rounded-xl px-4 text-sm transition',
        'active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60',
        variantClass,
        className,
      )}
    >
      {busy === true && <Spinner />}
      {children}
    </button>
  );
}
