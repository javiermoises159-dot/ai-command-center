import type { ReactNode } from 'react';

import { cx } from '../lib/format.ts';
import { href, useRouter, type Route } from '../lib/router.tsx';

const TABS: { route: Route; label: string; glyph: string }[] = [
  { route: { name: 'dashboard' }, label: 'Command', glyph: '◎' },
  { route: { name: 'missions' }, label: 'Missions', glyph: '≣' },
];

export function Layout({ children }: { children: ReactNode }) {
  const { route } = useRouter();
  const activeName = route.name === 'mission' ? 'missions' : route.name;

  return (
    <div className="relative z-10 flex min-h-dvh flex-col">
      <header className="safe-top sticky top-0 z-20 border-b border-[var(--color-edge)] bg-[var(--color-void)]/85 backdrop-blur-xl">
        <div className="mx-auto flex h-14 w-full max-w-3xl items-center gap-2.5 px-4">
          <a href={href({ name: 'dashboard' })} className="flex items-center gap-2.5">
            <Mark />
            <span className="text-[0.82rem] font-semibold tracking-[0.16em] text-[var(--color-ink)] uppercase">
              Command Center
            </span>
          </a>
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 px-4 pb-28 pt-4">{children}</main>

      {/* Bottom tab bar: thumb-reachable, which matters more than a sidebar on a phone. */}
      <nav className="safe-bottom fixed inset-x-0 bottom-0 z-20 border-t border-[var(--color-edge)] bg-[var(--color-void)]/90 backdrop-blur-xl">
        <div className="mx-auto flex w-full max-w-3xl">
          {TABS.map((tab) => {
            const active = activeName === tab.route.name;
            return (
              <a
                key={tab.label}
                href={href(tab.route)}
                aria-current={active ? 'page' : undefined}
                className={cx(
                  'flex flex-1 flex-col items-center gap-0.5 py-2.5 text-[0.62rem] uppercase tracking-[0.14em] transition',
                  active ? 'text-[var(--color-signal)]' : 'text-[var(--color-ink-faint)] hover:text-[var(--color-ink-dim)]',
                )}
              >
                <span className="text-base leading-none" aria-hidden>
                  {tab.glyph}
                </span>
                {tab.label}
              </a>
            );
          })}
        </div>
      </nav>
    </div>
  );
}

function Mark() {
  return (
    <svg viewBox="0 0 32 32" className="h-6 w-6" aria-hidden>
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
