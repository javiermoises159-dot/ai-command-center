/**
 * A small hash router.
 *
 * Hash routing rather than history routing so the built app works from any
 * static host (and from an iOS home-screen launch) with no server rewrite
 * rules. The app has nine top-level sections plus a mission detail; a routing
 * library would be more code than this and one more dependency to keep current.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export const SECTION_NAMES = [
  'dashboard',
  'missions',
  'agents',
  'knowledge',
  'research',
  'tools',
  'creative',
  'content',
  'activity',
  'settings',
] as const;

export type SectionName = (typeof SECTION_NAMES)[number];

export type Route =
  | { name: SectionName }
  | { name: 'mission'; id: string }
  | { name: 'not-found'; path: string };

/** URL path of each section. The dashboard owns the root. */
const SECTION_PATHS: Record<SectionName, string> = {
  dashboard: '/',
  missions: '/missions',
  agents: '/agents',
  knowledge: '/knowledge',
  research: '/research',
  tools: '/tools',
  creative: '/creative',
  content: '/content',
  activity: '/activity',
  settings: '/settings',
};

const PATH_TO_SECTION = new Map<string, SectionName>(
  SECTION_NAMES.map((name) => [SECTION_PATHS[name], name] as const),
);

export function parse(hash: string): Route {
  const raw = hash.replace(/^#/, '') || '/';
  // A trailing slash is the same screen; the root keeps its single slash.
  const path = raw.length > 1 ? raw.replace(/\/+$/, '') : raw;

  const section = PATH_TO_SECTION.get(path);
  if (section !== undefined) return { name: section };

  const mission = /^\/missions\/([^/]+)$/.exec(path);
  if (mission?.[1] !== undefined) return { name: 'mission', id: decodeURIComponent(mission[1]) };

  return { name: 'not-found', path };
}

export function href(route: Route): string {
  switch (route.name) {
    case 'mission':
      return `#/missions/${encodeURIComponent(route.id)}`;
    case 'not-found':
      return '#/';
    default:
      return `#${SECTION_PATHS[route.name]}`;
  }
}

/** The section a route belongs to, for highlighting navigation. */
export function sectionOf(route: Route): SectionName | null {
  if (route.name === 'mission') return 'missions';
  if (route.name === 'not-found') return null;
  return route.name;
}

interface RouterValue {
  route: Route;
  navigate(route: Route): void;
}

const RouterContext = createContext<RouterValue | null>(null);

export function RouterProvider({ children }: { children: ReactNode }) {
  const [route, setRoute] = useState<Route>(() => parse(window.location.hash));

  useEffect(() => {
    const onChange = () => {
      setRoute(parse(window.location.hash));
      window.scrollTo({ top: 0 });
    };
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  const navigate = useCallback((next: Route) => {
    window.location.hash = href(next);
  }, []);

  const value = useMemo(() => ({ route, navigate }), [route, navigate]);
  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>;
}

export function useRouter(): RouterValue {
  const value = useContext(RouterContext);
  if (value === null) throw new Error('useRouter must be used inside a RouterProvider.');
  return value;
}
