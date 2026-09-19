/**
 * Theme handling: light, dark, or follow the system.
 *
 * The user's choice is stored in localStorage; the *resolved* theme
 * (light | dark) is written to <html data-theme>, which is what the CSS keys on.
 * The same resolution runs in an inline script in index.html before first paint
 * so there is no flash of the wrong theme on load. Every storage access is
 * wrapped, because storage can throw (private mode, blocked site data).
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'acc-theme';

function readPreference(): ThemePreference {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
  } catch {
    // Storage unavailable: fall through to the default.
  }
  return 'dark';
}

function systemTheme(): ResolvedTheme {
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export function resolveTheme(preference: ThemePreference): ResolvedTheme {
  return preference === 'system' ? systemTheme() : preference;
}

interface ThemeValue {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  setPreference(next: ThemePreference): void;
  /** Flip between light and dark explicitly (used by the header toggle). */
  toggle(): void;
}

const ThemeContext = createContext<ThemeValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(readPreference);
  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolveTheme(readPreference()));

  // Keep <html data-theme> and the browser chrome colour in step with the choice.
  useEffect(() => {
    const apply = () => {
      const next = resolveTheme(preference);
      setResolved(next);
      document.documentElement.dataset['theme'] = next;
      document
        .querySelector('meta[name="theme-color"]')
        ?.setAttribute('content', next === 'light' ? '#f4f6fb' : '#05070d');
    };
    apply();

    // Only "system" needs to react to the OS changing its own setting.
    if (preference !== 'system') return undefined;
    const media = window.matchMedia('(prefers-color-scheme: light)');
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [preference]);

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // The choice still applies for this session.
    }
  }, []);

  const toggle = useCallback(() => {
    setPreference(resolveTheme(preference) === 'dark' ? 'light' : 'dark');
  }, [preference, setPreference]);

  const value = useMemo(
    () => ({ preference, resolved, setPreference, toggle }),
    [preference, resolved, setPreference, toggle],
  );
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeValue {
  const value = useContext(ThemeContext);
  if (value === null) throw new Error('useTheme must be used inside a ThemeProvider.');
  return value;
}
