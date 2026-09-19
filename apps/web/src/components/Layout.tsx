import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import { useHealth } from '../hooks/useApi.ts';
import { cx } from '../lib/format.ts';
import { NAV_ITEMS, type NavItem } from '../lib/nav.ts';
import { href, sectionOf, useRouter } from '../lib/router.tsx';
import { useTheme } from '../lib/theme.tsx';
import { Icon } from './icons.tsx';

export function Layout({ children }: { children: ReactNode }) {
  const { route } = useRouter();
  const active = sectionOf(route);
  const [moreOpen, setMoreOpen] = useState(false);
  // Stable identity: the sheet's focus/scroll-lock effect depends on it.
  const closeMore = useCallback(() => setMoreOpen(false), []);

  // Any navigation closes the "More" sheet.
  useEffect(() => {
    setMoreOpen(false);
  }, [route]);

  return (
    <div className="relative z-10 min-h-dvh">
      <Sidebar active={active} />

      <div className="flex min-h-dvh flex-col lg:pl-64">
        <MobileTopBar />
        <main className="mx-auto w-full max-w-5xl flex-1 px-4 pb-28 pt-5 sm:px-6 lg:px-8 lg:pb-12 lg:pt-8">
          {/* Keyed on the route so every screen change replays the entrance. */}
          <div key={route.name === 'mission' ? `mission-${route.id}` : route.name} className="acc-fade">
            {children}
          </div>
        </main>
      </div>

      <BottomNav active={active} moreOpen={moreOpen} onMore={() => setMoreOpen(true)} />
      {moreOpen && <MoreSheet active={active} onClose={closeMore} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Desktop sidebar
// ---------------------------------------------------------------------------

function Sidebar({ active }: { active: NavItem['name'] | null }) {
  return (
    <aside
      aria-label="Primary"
      className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col border-r border-[var(--color-edge)] bg-[var(--color-surface)]/90 backdrop-blur-xl lg:flex"
    >
      <a href={href({ name: 'dashboard' })} className="flex items-center gap-3 px-5 pb-5 pt-6">
        <Mark className="h-8 w-8" />
        <span className="leading-tight">
          <span className="block text-[0.95rem] font-semibold tracking-tight text-[var(--color-ink)]">AI Command Center</span>
          <span className="block text-[0.68rem] uppercase tracking-[0.16em] text-[var(--color-ink-faint)]">Mission control</span>
        </span>
      </a>

      <nav className="flex-1 overflow-y-auto px-3 py-2" aria-label="Sections">
        <ul className="space-y-0.5">
          {NAV_ITEMS.map((item) => {
            const current = item.name === active;
            return (
              <li key={item.name}>
                <a
                  href={href({ name: item.name })}
                  aria-current={current ? 'page' : undefined}
                  className={cx(
                    'group relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-[0.88rem] transition',
                    current
                      ? 'bg-[var(--color-signal)]/12 font-medium text-[var(--color-signal)]'
                      : 'text-[var(--color-ink-dim)] hover:bg-[var(--color-tint)] hover:text-[var(--color-ink)]',
                  )}
                >
                  {current && (
                    <span className="absolute inset-y-2 left-0 w-[3px] rounded-r-full bg-[var(--color-signal)]" aria-hidden />
                  )}
                  <Icon name={item.icon} className="h-[1.15rem] w-[1.15rem]" />
                  {item.label}
                </a>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="space-y-3 border-t border-[var(--color-edge)] p-3">
        <SystemStatus />
        <ThemeToggle variant="row" />
      </div>
    </aside>
  );
}

/** The live status light: a real request to /api/health, refreshed every 15s. */
function SystemStatus({ compact = false }: { compact?: boolean }) {
  const health = useHealth();
  const online = health.data !== null && health.error === null;
  const checking = health.loading && health.data === null;

  const label = checking ? 'Checking…' : online ? 'API online' : 'API unreachable';
  const detail = online ? `v${health.data?.health.version} · ${health.data?.health.provider ?? 'no provider'}` : 'Is the server running?';

  const light = (
    <span
      className={cx(
        'inline-block h-2.5 w-2.5 shrink-0 rounded-full',
        checking ? 'bg-[var(--color-ink-faint)] acc-pulse' : online ? 'bg-[var(--color-ok)]' : 'bg-[var(--color-bad)]',
      )}
      aria-hidden
    />
  );

  if (compact) {
    return (
      <a
        href={href({ name: 'settings' })}
        className="flex items-center gap-2 rounded-full bg-[var(--color-tint)] px-2.5 py-1.5 text-[0.7rem] text-[var(--color-ink-dim)] ring-1 ring-[var(--color-line)]"
        aria-label={`System status: ${label}`}
      >
        {light}
        {label}
      </a>
    );
  }

  return (
    <a
      href={href({ name: 'settings' })}
      className="flex items-center gap-2.5 rounded-xl bg-[var(--color-tint)] px-3 py-2.5 ring-1 ring-[var(--color-line)] transition hover:bg-[var(--color-tint-strong)]"
      aria-label={`System status: ${label}. Open settings`}
    >
      {light}
      <span className="min-w-0 leading-tight">
        <span className="block text-[0.78rem] font-medium text-[var(--color-ink)]">{label}</span>
        <span className="block truncate text-[0.68rem] text-[var(--color-ink-faint)]">{detail}</span>
      </span>
    </a>
  );
}

function ThemeToggle({ variant }: { variant: 'row' | 'icon' }) {
  const { resolved, toggle } = useTheme();
  const next = resolved === 'dark' ? 'light' : 'dark';

  if (variant === 'icon') {
    return (
      <button
        type="button"
        onClick={toggle}
        aria-label={`Switch to ${next} mode`}
        className="grid h-9 w-9 place-items-center rounded-full bg-[var(--color-tint)] text-[var(--color-ink-dim)] ring-1 ring-[var(--color-line)] transition hover:text-[var(--color-ink)] active:scale-95"
      >
        <Icon name={resolved === 'dark' ? 'sun' : 'moon'} className="h-[1.05rem] w-[1.05rem]" />
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={toggle}
      className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-[0.85rem] text-[var(--color-ink-dim)] transition hover:bg-[var(--color-tint)] hover:text-[var(--color-ink)]"
    >
      <Icon name={resolved === 'dark' ? 'sun' : 'moon'} className="h-[1.15rem] w-[1.15rem]" />
      {resolved === 'dark' ? 'Light mode' : 'Dark mode'}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Mobile chrome
// ---------------------------------------------------------------------------

function MobileTopBar() {
  return (
    <header className="safe-top sticky top-0 z-20 border-b border-[var(--color-edge)] bg-[var(--color-void)]/85 backdrop-blur-xl lg:hidden">
      <div className="mx-auto flex h-14 w-full max-w-5xl items-center gap-2.5 px-4 sm:px-6">
        <a href={href({ name: 'dashboard' })} className="flex min-w-0 items-center gap-2.5">
          <Mark className="h-6 w-6" />
          <span className="truncate text-[0.82rem] font-semibold tracking-[0.14em] text-[var(--color-ink)] uppercase">
            Command Center
          </span>
        </a>
        <div className="ml-auto flex items-center gap-2">
          <SystemStatus compact />
          <ThemeToggle variant="icon" />
        </div>
      </div>
    </header>
  );
}

function BottomNav({
  active,
  moreOpen,
  onMore,
}: {
  active: NavItem['name'] | null;
  moreOpen: boolean;
  onMore: () => void;
}) {
  const primary = NAV_ITEMS.filter((item) => item.primary);
  // "More" lights up when the current screen is one of the sections it holds.
  const moreActive = moreOpen || (active !== null && !primary.some((item) => item.name === active));

  const tab = (isActive: boolean) =>
    cx(
      'flex flex-1 flex-col items-center gap-1 py-2.5 text-[0.64rem] font-medium tracking-wide transition',
      isActive ? 'text-[var(--color-signal)]' : 'text-[var(--color-ink-faint)] hover:text-[var(--color-ink-dim)]',
    );

  return (
    <nav
      aria-label="Primary"
      className="safe-bottom fixed inset-x-0 bottom-0 z-20 border-t border-[var(--color-edge)] bg-[var(--color-void)]/92 backdrop-blur-xl lg:hidden"
    >
      <div className="mx-auto flex w-full max-w-5xl">
        {primary.map((item) => (
          <a
            key={item.name}
            href={href({ name: item.name })}
            aria-current={active === item.name ? 'page' : undefined}
            className={tab(active === item.name)}
          >
            <Icon name={item.icon} className="h-[1.3rem] w-[1.3rem]" />
            {item.label}
          </a>
        ))}
        <button type="button" onClick={onMore} aria-haspopup="dialog" aria-expanded={moreOpen} className={tab(moreActive)}>
          <Icon name="more" className="h-[1.3rem] w-[1.3rem]" />
          More
        </button>
      </div>
    </nav>
  );
}

/** Bottom sheet holding the sections that do not fit in the tab bar. */
function MoreSheet({ active, onClose }: { active: NavItem['name'] | null; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const items = NAV_ITEMS.filter((item) => !item.primary);

  useEffect(() => {
    closeRef.current?.focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);

    // Stop the page scrolling behind the sheet.
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="More sections">
      <button
        type="button"
        aria-label="Close menu"
        onClick={onClose}
        className="acc-fade absolute inset-0 bg-black/55 backdrop-blur-[2px]"
        tabIndex={-1}
      />
      <div className="acc-sheet safe-bottom absolute inset-x-0 bottom-0 rounded-t-3xl border-t border-[var(--color-edge-bright)] bg-[var(--color-surface)] shadow-2xl">
        <div className="mx-auto max-w-lg px-4 pb-4 pt-3">
          <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-[var(--color-edge-bright)]" aria-hidden />
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-[0.7rem] font-semibold uppercase tracking-[0.18em] text-[var(--color-ink-faint)]">More sections</h2>
            <button
              ref={closeRef}
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="grid h-8 w-8 place-items-center rounded-full bg-[var(--color-tint)] text-[var(--color-ink-dim)]"
            >
              <Icon name="x" className="h-4 w-4" />
            </button>
          </div>
          <ul className="space-y-1">
            {items.map((item) => (
              <li key={item.name}>
                <a
                  href={href({ name: item.name })}
                  aria-current={active === item.name ? 'page' : undefined}
                  className={cx(
                    'flex items-center gap-3.5 rounded-2xl px-3 py-3 transition active:scale-[0.99]',
                    active === item.name
                      ? 'bg-[var(--color-signal)]/12 text-[var(--color-signal)]'
                      : 'text-[var(--color-ink)] hover:bg-[var(--color-tint)]',
                  )}
                >
                  <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[var(--color-tint)] ring-1 ring-[var(--color-line)]">
                    <Icon name={item.icon} className="h-5 w-5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[0.92rem] font-medium">{item.label}</span>
                    <span className="block truncate text-[0.74rem] text-[var(--color-ink-faint)]">{item.blurb}</span>
                  </span>
                  <Icon name="chevron-right" className="h-4 w-4 text-[var(--color-ink-faint)]" />
                </a>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

function Mark({ className }: { className: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden>
      <circle cx="16" cy="16" r="12" fill="none" stroke="currentColor" strokeOpacity="0.28" strokeWidth="1.6" />
      <path
        d="M16 7.5a8.5 8.5 0 1 1-6.01 14.51"
        fill="none"
        stroke="var(--color-signal)"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
      <circle cx="16" cy="16" r="3" fill="var(--color-signal)" />
      <circle cx="26" cy="12" r="2" fill="var(--color-plasma)" />
      <circle cx="9" cy="24" r="2" fill="var(--color-plasma)" />
    </svg>
  );
}
